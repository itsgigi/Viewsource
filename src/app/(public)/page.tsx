import Link from "next/link";
import { prisma } from "@/lib/db";
import { SearchBar } from "./search-bar";
import ShinyText from "@/components/ShinyText";

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

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const sites = await prisma.site.findMany({
    where: {
      visibility: "published",
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
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
          <img src="/logovs.png" alt="Viewsource" className="h-7 w-7 rounded-md object-contain" />
          <span className="font-semibold tracking-tight text-zinc-900">Viewsource</span>
        </Link>
      </div>

      {/* Hero */}
      <div className="mt-10">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">
          Recreate. Learn.{" "}
          <ShinyText
            text="Own the code."
            className="font-serif"
            color="#8b5cf6"
            shineColor="#38bdf8"
            speed={5.5}
            spread={110}
          />
        </h1>
        <p className="mt-3 text-base text-zinc-500">
          A curated gallery of notable sites: explore the AI analysis of each and
          extract components as code or prompts.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
          <span className="flex items-center gap-2">
            <GlobeIcon />
            Awwward winning websites
          </span>
          <span className="hidden h-4 w-px bg-zinc-200 sm:block" />
          <span className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
            </svg>
            Access to code
          </span>
          <span className="hidden h-4 w-px bg-zinc-200 sm:block" />
          <span className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <rect x="5" y="11" width="14" height="9" rx="1.5" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Copy. Learn. Build.
          </span>
        </div>
      </div>

      {/* Search */}
      <div className="mt-10 w-full">
        <SearchBar defaultValue={q ?? ""} />
      </div>

      {/* Gallery */}
      <div className="mt-8">
        {sites.length === 0 && (
          <p className="text-sm text-zinc-400">
            {q ? `No sites match "${q}".` : "No sites published yet. Check back soon!"}
          </p>
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
