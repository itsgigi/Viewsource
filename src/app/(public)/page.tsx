import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5V15.5M8.5 6H14a3.5 3.5 0 0 1 3.5 3.5V8.5" />
    </svg>
  );
}

export default async function GalleryPage() {
  const sites = await prisma.site.findMany({
    where: { visibility: "published" },
    orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      sourceType: true,
      sourceUrl: true,
      screenshot: true,
      cover: true,
      techStack: true,
      featured: true,
    },
  });

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 pb-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-xs font-bold text-white">
            si
          </span>
          <span className="font-semibold tracking-tight text-zinc-900">Site Ingest</span>
        </Link>
      </div>

      {/* Hero */}
      <div className="mt-10">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">
          Siti selezionati. <span className="font-serif italic text-zinc-400">Componenti</span>{" "}
          pronti da estrarre.
        </h1>
        <p className="mt-3 text-base text-zinc-500">
          Una galleria curata di siti notevoli: esplora l&apos;analisi AI di ciascuno ed
          estrai i componenti come codice o prompt.
        </p>
      </div>

      {/* Gallery */}
      <div className="mt-10">
        {sites.length === 0 && (
          <p className="text-sm text-zinc-400">Nessun sito pubblicato al momento. Torna presto!</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => {
            const techStack = (s.techStack as string[] | null) ?? [];
            const coverUrl = s.cover ?? s.screenshot;
            return (
              <Link
                key={s.id}
                href={`/sites/${s.slug}`}
                className="group overflow-hidden rounded-xl border border-zinc-200 bg-white transition hover:shadow-sm"
              >
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt={`${s.name} cover`}
                    className="h-36 w-full border-b border-zinc-200 object-cover object-top"
                  />
                ) : (
                  <div className="flex h-36 w-full items-center justify-center border-b border-zinc-200 bg-linear-to-br from-zinc-50 to-zinc-100 text-zinc-300">
                    {s.sourceType === "git" ? <GitBranchIcon /> : <GlobeIcon />}
                  </div>
                )}

                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-900 group-hover:underline">
                      {s.name}
                    </span>
                    {s.featured && (
                      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        featured
                      </span>
                    )}
                  </div>
                  {techStack.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {techStack.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] text-zinc-600"
                        >
                          {t}
                        </span>
                      ))}
                      {techStack.length > 4 && (
                        <span className="px-1 py-0.5 text-[10px] text-zinc-400">
                          +{techStack.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
