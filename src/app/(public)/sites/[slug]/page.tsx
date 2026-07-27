"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SignInButton, UserButton, useUser } from "@clerk/nextjs";

// Auth utenti pubblici (Clerk), separata dal cookie admin. Se le chiavi non
// sono configurate l'app resta usabile: i componenti Clerk (useUser,
// SignInButton...) non vengono mai montati, quindi non serve <ClerkProvider>.
const CLERK_ENABLED = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

interface Component {
  id: string;
  name: string;
  kind: "layout" | "section" | "ui" | "animation";
  description: string;
  cover: string | null;
  coverType: "image" | "video" | null;
  sourcePath: string | null;
  code: string | null;
  prompt: string | null;
  deps: string[] | null;
  // Solo componenti origin "ast" (ingestion da repo, sourceType "git")
  previewImage?: string | null;
}

// Sezione pubblicata dallo studio di ricostruzione assistita
// (src/lib/reconstruction/publish.ts) — l'unità mostrata pubblicamente,
// sostituisce i Component come vetrina primaria del sito (vedi piano
// Viewsource v2). Mappata in GalleryItem qui sotto per riusare
// ExtractModal/CopyPromptButton (pensati per Component) senza duplicarli.
interface SiteSection {
  id: string;
  order: number;
  name: string;
  renderScreenshot: string | null;
  generatedCode: string | null;
  prompt: string | null;
}

function sectionToGalleryItem(s: SiteSection): Component {
  return {
    id: s.id,
    name: s.name,
    kind: "section",
    description: `Sezione #${s.order + 1}`,
    cover: s.renderScreenshot,
    coverType: "image",
    sourcePath: null,
    code: s.generatedCode,
    prompt: s.prompt,
    deps: null,
  };
}

interface Doc {
  id: string;
  path: string;
  kind: "page" | "file";
  summary: string | null;
}

interface SiteDetail {
  id: string;
  name: string;
  slug: string;
  sourceType: "url" | "git";
  sourceUrl: string;
  description: string | null;
  deployedUrl: string | null;
  techStack: string[] | null;
  designInfo: { palette?: string[]; fonts?: string[]; notes?: string } | null;
  screenshot: string | null;
  awwwards: AwwwardsInfo | null;
  components: Component[];
  sections: SiteSection[];
  documents: Doc[];
  price: number | null; // centesimi; null = codice sempre gratis
  unlocked: boolean;
}

interface AwwwardsInfo {
  url: string;
  title: string;
  award: string | null;
  awardDate: string | null;
  scores: Record<string, number | null>;
  tags: string[];
  credits: { name: string; url: string | null }[];
  description: string | null;
  gallery: { label: string; imageUrl: string }[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
}

type ExtractMode = "code" | "prompt";

interface Extraction {
  mode: ExtractMode;
  code?: string;
  filename?: string;
  deps?: string[];
  prompt?: string;
  notes?: string;
  // Bundle multi-file completo — solo componenti origin "ast" (repo), mode "code"
  files?: { path: string; content: string }[];
}

const KIND_BADGE: Record<Component["kind"], string> = {
  layout: "bg-blue-50 text-blue-700",
  section: "bg-violet-50 text-violet-700",
  ui: "bg-emerald-50 text-emerald-700",
  animation: "bg-orange-50 text-orange-700",
};

const KIND_GRADIENT: Record<Component["kind"], string> = {
  layout: "from-slate-100 to-blue-50",
  section: "from-indigo-50 to-amber-50",
  ui: "from-emerald-50 to-teal-50",
  animation: "from-orange-50 to-amber-50",
};

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <path d="M14 5h5v5M19 5l-8 8M8 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </svg>
  );
}

function PageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M3 9h18" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

function ComponentThumbnail({ kind }: { kind: Component["kind"] }) {
  return (
    <div
      className={`flex h-56 items-center justify-center gap-2 rounded-t-xl bg-linear-to-br p-4 ${KIND_GRADIENT[kind]}`}
    >
      {kind === "section" && (
        <div className="flex w-full flex-col gap-1.5">
          <div className="h-2 w-2/3 rounded bg-zinc-900/10" />
          <div className="h-2 w-1/2 rounded bg-zinc-900/10" />
          <div className="mt-1 h-2.5 w-24 rounded bg-zinc-900" />
        </div>
      )}
      {kind === "layout" && (
        <>
          <div className="h-16 w-10 rounded-md bg-white/70" />
          <div className="h-16 flex-1 rounded-md bg-white/50" />
        </>
      )}
      {kind === "ui" && <div className="h-8 w-32 rounded-full bg-white/70" />}
      {kind === "animation" && (
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-6 w-14 rounded-full ${i === 1 ? "bg-zinc-900/80" : "bg-white/60"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentCover({ component }: { component: Component }) {
  if (!component.cover) return <ComponentThumbnail kind={component.kind} />;

  if (component.coverType === "video") {
    return (
      <video
        src={component.cover}
        className="h-56 w-full rounded-t-xl object-cover object-top"
        autoPlay
        muted
        loop
        playsInline
      />
    );
  }

  return (
    <img
      src={component.cover}
      alt={`${component.name} cover`}
      className="h-56 w-full rounded-t-xl object-cover object-top"
    />
  );
}

function lastPathSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function renderWithInlineCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function SitePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<"gallery" | "documents" | "chat">("gallery");
  const [extracting, setExtracting] = useState<Component | null>(null);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { isSignedIn } = CLERK_ENABLED ? useUser() : { isSignedIn: false };

  useEffect(() => {
    fetch(`/api/sites/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setSite)
      .catch(() => setNotFound(true));
  }, [slug]);

  if (notFound) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-zinc-500">Sito non trovato.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-zinc-700 underline">
          ← Torna alla galleria
        </Link>
      </main>
    );
  }

  if (!site) {
    return <main className="mx-auto max-w-4xl px-6 py-12 text-zinc-400">Loading…</main>;
  }

  const techStack = site.techStack ?? [];
  const designInfo = site.designInfo;
  const awwwards = site.awwwards;

  // Le due modalità di ingestion condividono questa pagina: "git" mostra i
  // Component reali (origin "ast", preview via albero fiber React), "url"
  // mostra le Section pubblicate dallo studio di ricostruzione. Stessa
  // griglia/modale, sorgente dati ed endpoint di estrazione diversi.
  const isRepo = site.sourceType === "git";
  const galleryItems: Component[] = isRepo
    ? site.components.map((c) => ({
        ...c,
        cover: c.previewImage ?? c.cover,
        coverType: c.previewImage ? "image" : c.coverType,
      }))
    : site.sections.map(sectionToGalleryItem);
  const galleryLabel = isRepo ? "Components" : "Sections";
  const galleryEndpoint = (componentId: string) =>
    isRepo
      ? `/api/sites/${site.slug}/components/${componentId}`
      : `/api/sites/${site.slug}/sections/${componentId}`;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <Link href="/" className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-900 text-[10px] font-bold text-white">
              si
            </span>
            Site Ingest
          </Link>
          <span className="text-zinc-300">/</span>
          <span className="text-zinc-900">{site.name}</span>
        </div>
        {CLERK_ENABLED && (
          <div className="flex items-center gap-2">
            {isSignedIn ? (
              <UserButton />
            ) : (
              <SignInButton mode="modal">
                <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400">
                  Accedi
                </button>
              </SignInButton>
            )}
          </div>
        )}
      </div>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">{site.name}</h1>
          <a
            href={site.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
          >
            {site.sourceUrl}
            <ExternalLinkIcon />
          </a>
        </div>
      </div>

      {/* Preview live del sito deployato */}
      {site.deployedUrl && (
        <section className="mt-8 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
            <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
              Live preview
            </h2>
            <a
              href={site.deployedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900"
            >
              {site.deployedUrl}
              <ExternalLinkIcon />
            </a>
          </div>
          <iframe src={site.deployedUrl} className="h-140 w-full" title={`${site.name} live preview`} />
        </section>
      )}

      {/* AI Analysis */}
      {site.description && (
        <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
            AI Analysis
          </h2>
          <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-zinc-700">
            {site.description}
          </p>
        </section>
      )}

      {/* Awwwards */}
      {awwwards && (
        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
              Awwwards
            </h2>
            <a
              href={awwwards.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900"
            >
              View on awwwards.com
              <ExternalLinkIcon />
            </a>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {awwwards.award && (
              <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white">
                🏆 {awwwards.award}
                {awwwards.awardDate ? ` · ${awwwards.awardDate}` : ""}
              </span>
            )}
          </div>

          {awwwards.description && (
            <p className="mt-3 text-sm leading-relaxed text-zinc-600">
              {awwwards.description}
            </p>
          )}

          {awwwards.tags?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {awwwards.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[11px] text-zinc-600"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {awwwards.credits?.length > 0 && (
            <p className="mt-3 text-xs text-zinc-500">
              Credits ·{" "}
              {awwwards.credits.map((c, i) => (
                <span key={c.name}>
                  {i > 0 && ", "}
                  {c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-700 underline-offset-2 hover:underline"
                    >
                      {c.name}
                    </a>
                  ) : (
                    <span className="text-zinc-700">{c.name}</span>
                  )}
                </span>
              ))}
            </p>
          )}

          {awwwards.gallery?.length > 0 && (
            <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
              {awwwards.gallery.map((g) => (
                <a
                  key={g.imageUrl}
                  href={awwwards.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0"
                >
                  <img
                    src={g.imageUrl}
                    alt={g.label}
                    className="h-28 w-44 rounded-lg border border-zinc-200 object-cover object-top transition hover:opacity-90"
                  />
                  <p className="mt-1 text-center text-[10px] capitalize text-zinc-400">
                    {g.label}
                  </p>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Tech stack + design */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {techStack.length > 0 && (
          <section className="rounded-xl border border-zinc-200 bg-white p-5">
            <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
              Tech stack
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {techStack.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-xs text-zinc-700"
                >
                  {t}
                </span>
              ))}
            </div>
          </section>
        )}

        {(designInfo || site.screenshot) && (
          <section className="rounded-xl border border-zinc-200 bg-white p-5">
            <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
              Design
            </h2>
            {site.screenshot && (
              <a
                href={site.screenshot}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block overflow-hidden rounded-lg border border-zinc-200"
              >
                <img
                  src={site.screenshot}
                  alt={`${site.name} homepage screenshot`}
                  className="h-40 w-full object-cover object-top transition hover:opacity-90"
                />
              </a>
            )}
            {designInfo?.palette && designInfo.palette.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {designInfo.palette.map((c) => (
                  <span key={c} className="flex flex-col items-center gap-1 text-[10px] text-zinc-400">
                    <span
                      className="inline-block h-7 w-7 rounded-full border border-zinc-200"
                      style={{ backgroundColor: c }}
                    />
                    {c}
                  </span>
                ))}
              </div>
            )}
            {designInfo?.fonts && designInfo.fonts.length > 0 && (
              <p className="mt-3 text-xs text-zinc-500">
                Fonts · {designInfo.fonts.join(", ")}
              </p>
            )}
            {designInfo?.notes && (
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">{designInfo.notes}</p>
            )}
          </section>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-8 flex gap-1 border-b border-zinc-200">
        {(
          [
            ["gallery", galleryLabel, galleryItems.length],
            ["documents", "Documents", site.documents.length],
            ["chat", "AI Chat", null],
          ] as const
        ).map(([t, label, count]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm transition ${
              tab === t
                ? "border-b-2 border-zinc-900 font-medium text-zinc-900"
                : "text-zinc-400 hover:text-zinc-700"
            }`}
          >
            {label}
            {count !== null && (
              <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Gallery: Components (repo) o Sections (ricostruzione) */}
      {tab === "gallery" && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {galleryItems.length === 0 && (
            <p className="text-sm text-zinc-400">
              {isRepo ? "No components published yet." : "No sections published yet."}
            </p>
          )}
          {galleryItems.map((c) => (
            <div
              key={c.id}
              className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white"
            >
              <div className="relative">
                <ComponentCover component={c} />
                <span
                  className={`absolute right-2.5 top-2.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE[c.kind]}`}
                >
                  {c.kind}
                </span>
              </div>
              <div className="flex flex-1 flex-col p-4">
                <span className="font-medium text-zinc-900">{c.name}</span>
                <p className="mt-1.5 flex-1 text-xs leading-relaxed text-zinc-500">
                  {c.description}
                </p>
                {c.sourcePath && (
                  <p className="mt-2 truncate font-mono text-[11px] text-zinc-400">
                    {c.sourcePath}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <CopyPromptButton endpoint={galleryEndpoint(c.id)} component={c} />
                  <button
                    onClick={() => setExtracting(c)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700"
                  >
                    {site.price && !site.unlocked && !c.code && <LockIcon />}
                    {c.code ? "View code" : "Get code"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Documents */}
      {tab === "documents" && (
        <div className="mt-6 flex flex-col divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
          {site.documents.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
                {d.kind === "page" ? <PageIcon /> : <FileIcon />}
              </span>
              <span className="flex-1 truncate font-mono text-xs text-zinc-700">{d.path}</span>
              <span className="shrink-0 text-xs text-zinc-400">
                {d.kind === "page" ? "page" : "source"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Chat */}
      {tab === "chat" && <SiteChat slug={site.slug} />}

      {/* Extraction modal */}
      {extracting && (
        <ExtractModal
          slug={site.slug}
          endpoint={galleryEndpoint(extracting.id)}
          component={extracting}
          price={site.price}
          unlocked={site.unlocked}
          onClose={() => setExtracting(null)}
          onSaved={(patch) =>
            setSite((s) => {
              if (!s) return s;
              return isRepo
                ? {
                    ...s,
                    components: s.components.map((c) =>
                      c.id === extracting.id ? { ...c, ...patch } : c
                    ),
                  }
                : {
                    ...s,
                    sections: s.sections.map((sec) =>
                      sec.id === extracting.id
                        ? { ...sec, prompt: patch.prompt ?? sec.prompt, generatedCode: patch.code ?? sec.generatedCode }
                        : sec
                    ),
                  };
            })
          }
        />
      )}
    </main>
  );
}

// ---------- Copia prompt: azione rapida, sempre gratis, niente modale ----------

function CopyPromptButton({ endpoint, component }: { endpoint: string; component: Component }) {
  const [state, setState] = useState<"idle" | "loading" | "copied" | "error">("idle");

  async function copyPrompt() {
    setState("loading");
    try {
      let prompt = component.prompt;
      if (!prompt) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "prompt" }),
        });
        if (!res.ok) throw new Error(`Error ${res.status}`);
        const data: Extraction = await res.json();
        prompt = data.prompt ?? "";
      }
      await navigator.clipboard.writeText(prompt);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 1500);
    }
  }

  return (
    <button
      onClick={copyPrompt}
      disabled={state === "loading"}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 disabled:opacity-50"
    >
      <CopyIcon />
      {state === "loading"
        ? "Generating…"
        : state === "copied"
        ? "Copied"
        : state === "error"
        ? "Failed"
        : "Copy prompt"}
    </button>
  );
}

// ---------- Extraction modal (codice, gated su Unlock se il sito ha un prezzo) ----------

function ExtractModal({
  slug,
  endpoint,
  component,
  price,
  unlocked,
  onClose,
  onSaved,
}: {
  slug: string;
  endpoint: string;
  component: Component;
  price: number | null;
  unlocked: boolean;
  onClose: () => void;
  onSaved: (patch: Partial<Component>) => void;
}) {
  const [mode, setMode] = useState<ExtractMode>("code");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // CLERK_ENABLED è una costante di modulo (da env, fissa per tutta la
  // sessione): condizionare la hook su di essa non rompe le rules-of-hooks,
  // l'ordine delle chiamate resta identico ad ogni render di questa istanza.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { isSignedIn } = CLERK_ENABLED ? useUser() : { isSignedIn: false };

  async function unlock() {
    setCheckoutLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/checkout`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? `Errore ${res.status}`);
        setCheckoutLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore checkout");
      setCheckoutLoading(false);
    }
  }

  const [results, setResults] = useState<Partial<Record<ExtractMode, Extraction>>>(
    () => {
      const initial: Partial<Record<ExtractMode, Extraction>> = {};
      if (component.code) {
        initial.code = {
          mode: "code",
          code: component.code,
          filename: `${component.name.replace(/\s+/g, "")}.tsx`,
          deps: component.deps ?? [],
        };
      }
      if (component.prompt) {
        initial.prompt = { mode: "prompt", prompt: component.prompt };
      }
      return initial;
    }
  );

  const result = results[mode] ?? null;
  const codeLocked = mode === "code" && !!price && !unlocked;

  // Bundle multi-file (componenti origin "ast"): l'utente sceglie quale file
  // vedere/copiare, il file principale è selezionato di default.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const bundleFiles = mode === "code" ? result?.files ?? [] : [];
  const activeFile =
    bundleFiles.length > 0 ? bundleFiles.find((f) => f.path === activeFilePath) ?? bundleFiles[0] : null;

  const copyText = mode === "code" ? activeFile?.content ?? result?.code : result?.prompt;
  const displayFilename =
    mode === "code" ? (activeFile ? lastPathSegment(activeFile.path) : result?.filename) : "prompt.md";

  async function extract() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: Extraction = await res.json();
      setResults((r) => ({ ...r, [mode]: data }));
      onSaved(
        mode === "code"
          ? { code: data.code, deps: data.deps ?? [] }
          : { prompt: data.prompt }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!copyText) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-200 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <h3 className="font-semibold text-zinc-900">{component.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE[component.kind]}`}
            >
              {component.kind}
            </span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-900">
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* Output mode + extract */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-500">Output</label>
              <div className="flex rounded-lg border border-zinc-200 p-0.5 text-sm w-fit">
                {(
                  [
                    ["code", "Code"],
                    ["prompt", "LLM Prompt"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-md px-4 py-1.5 transition ${
                      mode === m
                        ? "bg-white text-zinc-900 shadow-sm"
                        : "text-zinc-400 hover:text-zinc-700"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {!result && !codeLocked && (
              <button
                onClick={extract}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
              >
                {loading
                  ? "Generating…"
                  : mode === "code"
                  ? "Extract code"
                  : "Generate prompt"}
              </button>
            )}

            {codeLocked &&
              (CLERK_ENABLED && !isSignedIn ? (
                <SignInButton mode="modal">
                  <button className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700">
                    <LockIcon /> Accedi per sbloccare
                  </button>
                </SignInButton>
              ) : (
                <button
                  onClick={unlock}
                  disabled={checkoutLoading}
                  className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
                >
                  <LockIcon />
                  {checkoutLoading
                    ? "Redirecting…"
                    : `Sblocca il codice di questo sito — €${((price ?? 0) / 100).toFixed(2)}`}
                </button>
              ))}
          </div>

          <p className="mt-3 text-xs text-zinc-500">
            {codeLocked
              ? "Il codice di questo componente fa parte del pacchetto a pagamento del sito: sblocco a vita, valido per TUTTI i componenti di questo sito."
              : mode === "code"
              ? "Codice React + TypeScript + Tailwind CSS pronto da incollare nel tuo progetto."
              : "Prompt per Claude Code, Cursor o un altro LLM: ricrea il componente adattato alle convenzioni del progetto ospite."}
          </p>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          {loading && (
            <p className="mt-4 animate-pulse text-sm text-zinc-400">
              {mode === "code" ? "Preparing code…" : "Writing the prompt…"}
            </p>
          )}

          {/* Result */}
          {result && !loading && (
            <div className="mt-5">
              {bundleFiles.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {bundleFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setActiveFilePath(f.path)}
                      className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition ${
                        (activeFile?.path ?? bundleFiles[0].path) === f.path
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                      }`}
                    >
                      {lastPathSegment(f.path)}
                    </button>
                  ))}
                </div>
              )}
              <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
                  <span className="font-mono text-xs text-zinc-400">{displayFilename}</span>
                  <button
                    onClick={copy}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
                  >
                    <CopyIcon />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="max-h-90 overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-zinc-200">
                  <code>{copyText}</code>
                </pre>
              </div>

              {mode === "code" && result.deps && result.deps.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-widest text-zinc-400">
                    Dependencies
                  </span>
                  {result.deps.map((d) => (
                    <span
                      key={d}
                      className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 font-mono text-xs text-zinc-700"
                    >
                      {d}
                    </span>
                  ))}
                </div>
              )}

              {result.notes && (
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  {renderWithInlineCode(result.notes)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Chat (fake door: l'endpoint registra l'intento) ----------

function SiteChat({ slug }: { slug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((m) => [...m, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch(`/api/sites/${slug}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      if (!res.ok) {
        throw new Error(`Error ${res.status}`);
      }

      const data = await res.json();
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer, sources: data.sources },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Something went wrong: ${
            err instanceof Error ? err.message : "unknown error"
          }. Try again.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-6 flex h-130 flex-col rounded-xl border border-zinc-200 bg-white">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-5">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-400">
            Ask something about the project: how it&apos;s structured, what tech it uses,
            where a certain feature lives…
          </p>
        )}

        <div className="flex flex-col gap-4">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "self-end" : "self-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-line ${
                  m.role === "user"
                    ? "bg-zinc-900 text-white"
                    : "bg-zinc-100 text-zinc-900"
                }`}
              >
                {renderWithInlineCode(m.content)}
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.sources.slice(0, 4).map((s) => (
                    <span
                      key={s}
                      className="flex max-w-60 items-center gap-1 truncate rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] text-zinc-500"
                      title={s}
                    >
                      <FileIcon />
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="self-start rounded-2xl bg-zinc-100 px-4 py-2.5 text-sm text-zinc-500">
              <span className="animate-pulse">Searching the project…</span>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 border-t border-zinc-200 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about this site…"
          className="flex-1 rounded-full border border-zinc-200 px-4 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-400"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:opacity-50"
          aria-label="Send"
        >
          <ArrowUpIcon />
        </button>
      </div>
    </div>
  );
}
