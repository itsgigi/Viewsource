import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { anonymizeCapture, type ClonePreview } from "@/lib/ingest/anonymize";

/**
 * Navigable clone showcase (Phase D): HTML+CSS captured (Phase A),
 * anonymized (Phase D, lazy with cache on Site.clonePreview) and served in
 * a sandboxed iframe — no allow-scripts: static structure/style only,
 * never arbitrary JS from the original site in our app's context.
 */
export default async function PreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site) notFound();

  if (site.visibility !== "published") {
    const cookieStore = await cookies();
    const isAdmin = await verifySessionToken(cookieStore.get(ADMIN_COOKIE)?.value);
    if (!isAdmin) notFound();
  }

  let preview = site.clonePreview as ClonePreview | null;
  let error: string | null = null;

  if (!preview) {
    try {
      preview = await anonymizeCapture(site.id);
    } catch (err) {
      error = err instanceof Error ? err.message : "Unknown error";
    }
  }

  if (!preview || error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-400">
          Preview not available{error ? `: ${error}` : "."}
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-400">
        <span>
          Demonstrative, anonymized clone of <strong>{site.name}</strong> — structure and style
          automatically recreated, brand/logos removed. Best-effort mitigation, not a legally
          immune copy.
        </span>
        <a
          href={site.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 underline underline-offset-2 hover:text-white"
        >
          View original site ↗
        </a>
      </div>
      <iframe
        title={`Clone preview of ${site.name}`}
        srcDoc={preview.html}
        sandbox="allow-same-origin"
        className="w-full flex-1 border-0 bg-zinc-900"
      />
    </div>
  );
}
