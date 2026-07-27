import { prisma } from "@/lib/db";
import type { Prisma, Site } from "@/generated/prisma/client";
import { captureHomepageScreenshot, captureScrollSequence, ingestWebsite } from "./firecrawl";
import { captureSite } from "./capture";
import { runRepoIngestion } from "./repo";
import { fetchAwwwardsData } from "./awwwards";
import { analyzeSite, embedSite } from "@/lib/analyze";
import { analyzeRepoComponents } from "@/lib/analyze/repo";

// Playwright ha bisogno dei browser binaries: gira SOLO in locale/admin,
// mai su Vercel serverless. Su Vercel la cattura reale viene saltata e la
// pipeline si appoggia solo a Firecrawl (fallback, meno accurato). Stessa
// convenzione di CAN_RUN_LOCAL_PIPELINE in src/lib/local-only.ts, usata
// direttamente dal ramo "git" (clone, dev server, Playwright).
const CAN_CAPTURE = !process.env.VERCEL;

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

    if (site.sourceType === "git") {
      await runGitIngestionPipeline(site);
    } else {
      await runUrlIngestionPipeline(site);
    }

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

// ---------- sourceType "git": clone + AST + preview + ranking LLM ----------

async function runGitIngestionPipeline(site: Site) {
  const { docs, license, metadata, packageJson, astComponents, previews, designTokens, cover } =
    await runRepoIngestion(site.id, site.sourceUrl, site.branch);

  if (docs.length === 0 && astComponents.length === 0) {
    throw new Error("Nessun contenuto trovato nella repo: verifica URL, branch e permessi del token");
  }

  for (const doc of docs) {
    await prisma.document.upsert({
      where: { siteId_path: { siteId: site.id, path: doc.path } },
      create: { siteId: site.id, ...doc },
      update: { content: doc.content },
    });
  }

  // Awwwards discovery needs a live URL to match against ("Visit site" host
  // verification) — sourceUrl is the git repo, not the deployed site, so we
  // use the repo's homepage metadata (or an already-set deployedUrl) instead.
  // A manually-provided site.awwwardsUrl always works regardless, since a
  // direct URL skips host verification entirely (see scrapeAwwwardsPage).
  const awwwardsReferenceUrl = site.deployedUrl ?? metadata.homepage ?? null;
  const awwwards = awwwardsReferenceUrl
    ? await fetchAwwwardsData(awwwardsReferenceUrl, site.awwwardsUrl)
    : null;

  await prisma.site.update({
    where: { id: site.id },
    data: {
      license,
      designInfo: designTokens as unknown as Prisma.InputJsonValue,
      // `screenshot` (auto, non "cover" che è la scelta manuale dell'admin,
      // vedi commento sul campo in schema.prisma) — priorità al full-page
      // catturato dalla preview, altrimenti quello del fallback URL deployata.
      ...(cover ? { screenshot: cover } : {}),
      // Solo se l'admin non l'ha già impostata a mano: un re-ingest non deve
      // sovrascrivere un deployedUrl scelto manualmente in un secondo momento.
      ...(!site.deployedUrl && metadata.homepage ? { deployedUrl: metadata.homepage } : {}),
      ...(awwwards ? { awwwards: awwwards as unknown as Prisma.InputJsonValue } : {}),
      metadata: {
        description: metadata.description,
        topics: metadata.topics,
        language: metadata.language,
        homepage: metadata.homepage,
        defaultBranch: metadata.defaultBranch,
        packageJson,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Re-ingestion: ripulisci i Component AST di un run precedente prima di ricrearli.
  await prisma.component.deleteMany({ where: { siteId: site.id, origin: "ast" } });

  if (astComponents.length > 0) {
    await prisma.component.createMany({
      data: astComponents.map((c) => ({
        siteId: site.id,
        name: c.name,
        kind: "ui", // placeholder: la Fase 4 (LLM) lo classifica per i componenti "worthy"
        description: `Componente estratto da ${c.filePath}.`,
        origin: "ast",
        filePath: c.filePath,
        sourcePath: c.filePath,
        propsSchema: JSON.stringify(c.props),
        bundleFiles: JSON.stringify(c.bundleFiles),
        npmDeps: JSON.stringify(c.npmDeps),
        previewImage: previews.get(c.filePath) ?? null,
        // Nascosto finché la Fase 4 non lo promuove esplicitamente: evita di
        // pubblicare wrapper banali o componenti fuori dal budget dell'LLM.
        excluded: true,
      })),
    });
  }

  await setStatus(site.id, "analyzing");

  await Promise.all([analyzeRepoComponents(site.id), embedSite(site.id)]);
}

// ---------- sourceType "url": firecrawl + cattura Playwright + analisi AI ----------

async function runUrlIngestionPipeline(site: Site) {
  const [docs, screenshot, scrollSequence, awwwards, capture] = await Promise.all([
    ingestWebsite(site.sourceUrl),
    captureHomepageScreenshot(site.sourceUrl),
    captureScrollSequence(site.sourceUrl),
    fetchAwwwardsData(site.sourceUrl, site.awwwardsUrl),
    CAN_CAPTURE
      ? captureSite(site.sourceUrl).catch((err) => {
          console.error("Playwright capture fallita, fallback a Firecrawl:", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  let resolvedScreenshot: string | null = screenshot;
  let resolvedScrollSequence: { screenshots: string[]; html: string | null } = scrollSequence;

  // La cattura reale (Playwright) ha priorità su quella di Firecrawl,
  // quando disponibile: HTML e screenshot più fedeli, niente crediti.
  if (capture?.html) resolvedScrollSequence = { ...resolvedScrollSequence, html: capture.html };
  if (capture?.screenshot) resolvedScreenshot = capture.screenshot;

  if (docs.length === 0) {
    throw new Error("Nessun contenuto trovato: URL vuoto o non raggiungibile");
  }

  for (const doc of docs) {
    await prisma.document.upsert({
      where: {
        siteId_path: { siteId: site.id, path: doc.path },
      },
      create: { siteId: site.id, ...doc },
      update: { content: doc.content },
    });
  }

  if (resolvedScreenshot) {
    await prisma.site.update({ where: { id: site.id }, data: { screenshot: resolvedScreenshot } });
  }

  if (resolvedScrollSequence.screenshots.length > 0) {
    await prisma.site.update({
      where: { id: site.id },
      data: { scrollScreenshots: resolvedScrollSequence.screenshots },
    });
  }

  if (awwwards) {
    await prisma.site.update({
      where: { id: site.id },
      data: { awwwards: awwwards as unknown as Prisma.InputJsonValue },
    });
  }

  if (resolvedScrollSequence.html) {
    const homepagePath =
      docs.find((d) => normalizeUrl(d.path) === normalizeUrl(site.sourceUrl))?.path ??
      docs.find((d) => d.kind === "page")?.path;

    if (homepagePath) {
      await prisma.document.update({
        where: { siteId_path: { siteId: site.id, path: homepagePath } },
        data: { html: resolvedScrollSequence.html },
      });
    }
  }

  if (capture && (capture.sections.length > 0 || capture.assets.length > 0)) {
    await prisma.site.update({
      where: { id: site.id },
      data: {
        capturedSections: capture.sections as unknown as Prisma.InputJsonValue,
        capturedAssets: capture.assets as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await setStatus(site.id, "analyzing");

  // Analisi e embeddings in parallelo: non dipendono l'una dall'altro
  await Promise.all([analyzeSite(site.id), embedSite(site.id)]);
}

function setStatus(id: string, status: string) {
  return prisma.site.update({ where: { id }, data: { status } });
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
