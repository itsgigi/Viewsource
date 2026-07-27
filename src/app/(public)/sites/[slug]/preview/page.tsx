import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { anonymizeCapture, type ClonePreview } from "@/lib/ingest/anonymize";

/**
 * Clone showcase navigabile (Fase D): HTML+CSS catturati (Fase A),
 * anonimizzati (Fase D, lazy con cache su Site.clonePreview) e serviti in
 * un iframe sandboxed — niente allow-scripts: solo struttura/stile statici,
 * mai JS arbitrario del sito originale nel contesto della nostra app.
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
      error = err instanceof Error ? err.message : "Errore sconosciuto";
    }
  }

  if (!preview || error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-500">
          Anteprima non disponibile{error ? `: ${error}` : "."}
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-500">
        <span>
          Clone dimostrativo e anonimizzato di <strong>{site.name}</strong> — struttura e stile
          ricreati automaticamente, brand/loghi rimossi. Mitigazione best-effort, non una copia
          legalmente immune.
        </span>
        <a
          href={site.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 underline underline-offset-2 hover:text-zinc-900"
        >
          Vedi il sito originale ↗
        </a>
      </div>
      <iframe
        title={`Clone preview di ${site.name}`}
        srcDoc={preview.html}
        sandbox="allow-same-origin"
        className="w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
