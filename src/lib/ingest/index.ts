import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  captureHomepageScreenshot,
  captureScrollSequence,
  ingestWebsite,
  type RawDoc,
} from "./firecrawl";
import { ingestGitRepo } from "./git";
import { fetchAwwwardsData, type AwwwardsData } from "./awwwards";
import { analyzeSite, embedSite } from "@/lib/analyze";

/**
 * Orchestratore completo: ingestion → analisi AI → embeddings → ready.
 * Va chiamato SENZA await dalla route API (fire-and-forget).
 */
export async function runIngestion(siteId: string) {
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
  });

  try {
    await setStatus(siteId, "ingesting");

    let docs: RawDoc[];
    let screenshot: string | null = null;
    let scrollSequence: { screenshots: string[]; html: string | null } = {
      screenshots: [],
      html: null,
    };
    let awwwards: AwwwardsData | null = null;

    if (site.sourceType === "git") {
      docs = await ingestGitRepo(site.sourceUrl);
    } else {
      [docs, screenshot, scrollSequence, awwwards] = await Promise.all([
        ingestWebsite(site.sourceUrl),
        captureHomepageScreenshot(site.sourceUrl),
        captureScrollSequence(site.sourceUrl),
        fetchAwwwardsData(site.sourceUrl, site.awwwardsUrl),
      ]);
    }

    if (docs.length === 0) {
      throw new Error("Nessun contenuto trovato: URL vuoto o non raggiungibile");
    }

    for (const doc of docs) {
      await prisma.document.upsert({
        where: {
          siteId_path: { siteId, path: doc.path },
        },
        create: { siteId, ...doc },
        update: { content: doc.content },
      });
    }

    if (screenshot) {
      await prisma.site.update({ where: { id: siteId }, data: { screenshot } });
    }

    if (scrollSequence.screenshots.length > 0) {
      await prisma.site.update({
        where: { id: siteId },
        data: { scrollScreenshots: scrollSequence.screenshots },
      });
    }

    if (awwwards) {
      await prisma.site.update({
        where: { id: siteId },
        data: { awwwards: awwwards as unknown as Prisma.InputJsonValue },
      });
    }

    if (scrollSequence.html) {
      const homepagePath = docs.find(
        (d) => normalizeUrl(d.path) === normalizeUrl(site.sourceUrl)
      )?.path ?? docs.find((d) => d.kind === "page")?.path;

      if (homepagePath) {
        await prisma.document.update({
          where: { siteId_path: { siteId, path: homepagePath } },
          data: { html: scrollSequence.html },
        });
      }
    }

    await setStatus(siteId, "analyzing");

    // Analisi e embeddings in parallelo: non dipendono l'una dall'altro
    await Promise.all([analyzeSite(siteId), embedSite(siteId)]);

    await setStatus(siteId, "ready");
  } catch (err) {
    await prisma.site.update({
      where: { id: siteId },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function setStatus(id: string, status: string) {
  return prisma.site.update({ where: { id }, data: { status } });
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
