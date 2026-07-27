"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface AdminSite {
  id: string;
  name: string;
  slug: string;
  sourceType: "url" | "git";
  sourceUrl: string;
  status: "pending" | "ingesting" | "analyzing" | "ready" | "failed";
  visibility: "draft" | "published";
  featured: boolean;
  error: string | null;
  createdAt: string;
  screenshot: string | null;
  cover: string | null;
  price: number | null; // centesimi; null = codice gratis (nessun paywall)
  chatIntents: number;
  _count: { documents: number; components: number };
}

interface MediaComponent {
  id: string;
  name: string;
  kind: string;
  cover: string | null;
  coverType: "image" | "video" | null;
}

const STATUS_STYLE: Record<
  AdminSite["status"],
  { badge: string; dot: string; pulse?: boolean }
> = {
  pending: { badge: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  ingesting: { badge: "bg-blue-50 text-blue-700", dot: "bg-blue-500", pulse: true },
  analyzing: { badge: "bg-violet-50 text-violet-700", dot: "bg-violet-500", pulse: true },
  ready: { badge: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  failed: { badge: "bg-red-50 text-red-700", dot: "bg-red-500" },
};

const STATUS_META: Record<AdminSite["status"], string> = {
  pending: "Queued",
  ingesting: "Crawling pages…",
  analyzing: "Mapping components…",
  ready: "",
  failed: "",
};

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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 16l-5-5-8 8" />
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

export default function AdminPage() {
  const [sites, setSites] = useState<AdminSite[]>([]);
  const [chatIntentTotal, setChatIntentTotal] = useState(0);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"url" | "git">("url");
  const [sourceUrl, setSourceUrl] = useState("");
  const [awwwardsUrl, setAwwwardsUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mediaSite, setMediaSite] = useState<AdminSite | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/sites");
    if (res.status === 401) {
      window.location.href = "/admin/login";
      return;
    }
    if (res.ok) {
      const data = await res.json();
      setSites(data.sites);
      setChatIntentTotal(data.chatIntentTotal);
    }
  }, []);

  useEffect(() => {
    fetch("/api/admin/sites")
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/admin/login";
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data) => {
        if (data) {
          setSites(data.sites);
          setChatIntentTotal(data.chatIntentTotal);
        }
      });
  }, []);

  const busy = sites.some(
    (s) => s.status === "pending" || s.status === "ingesting" || s.status === "analyzing"
  );

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter(
      (s) => s.name.toLowerCase().includes(q) || s.sourceUrl.toLowerCase().includes(q)
    );
  }, [sites, query]);

  const inProgress = sites.filter(
    (s) => s.status === "pending" || s.status === "ingesting" || s.status === "analyzing"
  ).length;

  async function createSite() {
    setFormError(null);

    if (!name.trim() || !sourceUrl.trim()) {
      setFormError("Name and URL are required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sourceType,
          sourceUrl,
          ...(awwwardsUrl.trim() ? { awwwardsUrl: awwwardsUrl.trim() } : {}),
          ...(sourceType === "git" && branch.trim() ? { branch: branch.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFormError(data?.error ? JSON.stringify(data.error) : `Error ${res.status}`);
        return;
      }

      setName("");
      setSourceUrl("");
      setAwwwardsUrl("");
      setBranch("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteSite(id: string) {
    await fetch(`/api/admin/sites/${id}`, { method: "DELETE" });
    await load();
  }

  async function toggleVisibility(site: AdminSite) {
    const visibility = site.visibility === "published" ? "draft" : "published";
    // Ottimistico: aggiorna subito, il reload conferma
    setSites((all) =>
      all.map((s) => (s.id === site.id ? { ...s, visibility } : s))
    );
    await fetch(`/api/admin/sites/${site.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    });
    await load();
  }

  async function setPrice(site: AdminSite, eurosInput: string) {
    const euros = parseFloat(eurosInput.replace(",", "."));
    const price = Number.isFinite(euros) && euros > 0 ? Math.round(euros * 100) : null;
    setSites((all) => all.map((s) => (s.id === site.id ? { ...s, price } : s)));
    await fetch(`/api/admin/sites/${site.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price }),
    });
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 pb-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-xs font-bold text-white">
              si
            </span>
            <span className="font-semibold tracking-tight text-zinc-900">Site Ingest</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <span className="font-medium text-zinc-900">Admin</span>
            <Link href="/" className="text-zinc-500 hover:text-zinc-900">
              Public gallery
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative hidden sm:block">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
              <SearchIcon />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sites…"
              className="w-64 rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-10 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-400"
            />
          </div>
          <button
            onClick={logout}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 transition hover:text-zinc-900"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Create site */}
      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-500">Site name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme-marketing"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-400"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-500">Source</label>
            <div className="flex rounded-lg border border-zinc-200 p-0.5 text-sm">
              {(
                [
                  ["url", "Website"],
                  ["git", "Git repo"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setSourceType(v)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition ${
                    sourceType === v
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-500 hover:text-zinc-900"
                  }`}
                >
                  {v === "url" ? <GlobeIcon /> : <GitBranchIcon />}
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-2 flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-500">URL</label>
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder={
                sourceType === "url" ? "https://example.com" : "https://github.com/user/repo.git"
              }
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-400"
            />
          </div>

          <button
            onClick={createSite}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create site"}
            {!submitting && <ArrowRightIcon />}
          </button>
        </div>

        {sourceType === "url" && (
          <div className="mt-3 flex items-center gap-2">
            <label className="shrink-0 text-xs text-zinc-400">
              Awwwards URL <span className="text-zinc-300">(optional)</span>
            </label>
            <input
              value={awwwardsUrl}
              onChange={(e) => setAwwwardsUrl(e.target.value)}
              placeholder="https://www.awwwards.com/sites/…  — auto-detected if left empty"
              className="w-full max-w-md rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-900 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
            />
          </div>
        )}

        {sourceType === "git" && (
          <div className="mt-3 flex items-center gap-2">
            <label className="shrink-0 text-xs text-zinc-400">
              Branch <span className="text-zinc-300">(optional — defaults to the repo&apos;s default branch)</span>
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full max-w-40 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-900 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
            />
          </div>
        )}

        {formError && <p className="mt-3 text-sm text-red-600">{formError}</p>}
      </div>

      {/* Sites */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-zinc-900">
          Sites{" "}
          <span className="text-sm font-normal text-zinc-400">
            {sites.length} total
            {inProgress > 0 ? ` · ${inProgress} in progress` : ""}
            {` · ${chatIntentTotal} chat intents`}
          </span>
        </h2>

        {filtered.length === 0 && (
          <p className="mt-4 text-sm text-zinc-400">
            {sites.length === 0
              ? "No sites yet. Create one above to get started."
              : "No sites match your search."}
          </p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => {
            const style = STATUS_STYLE[s.status];
            const meta =
              s.status === "ready"
                ? `${s._count.documents} docs · ${s._count.components} components`
                : s.status === "failed"
                ? s.error ?? "Failed"
                : STATUS_META[s.status];

            return (
              <div
                key={s.id}
                className="group relative overflow-hidden rounded-xl border border-zinc-200 bg-white transition hover:shadow-sm"
              >
                <button
                  onClick={() => deleteSite(s.id)}
                  className="absolute right-2.5 top-2.5 z-10 rounded-full bg-white/90 p-1.5 text-zinc-400 opacity-0 shadow-sm backdrop-blur-sm transition hover:text-red-600 group-hover:opacity-100"
                  aria-label="Delete site"
                >
                  <TrashIcon />
                </button>

                {(s.cover ?? s.screenshot) && (
                  <img
                    src={s.cover ?? s.screenshot ?? undefined}
                    alt={`${s.name} cover`}
                    className="h-28 w-full border-b border-zinc-200 object-cover object-top"
                  />
                )}

                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
                      {s.sourceType === "git" ? <GitBranchIcon /> : <GlobeIcon />}
                    </span>
                    <div className="min-w-0 pr-5">
                      <Link
                        href={`/sites/${s.slug}`}
                        className="block truncate font-medium text-zinc-900 hover:underline"
                      >
                        {s.name}
                      </Link>
                      <p className="truncate text-xs text-zinc-400">{s.sourceUrl}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${style.badge}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${style.dot} ${
                          style.pulse ? "animate-pulse" : ""
                        }`}
                      />
                      {s.status}
                    </span>
                    <span className="truncate text-xs text-zinc-400">{meta}</span>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3">
                    <button
                      onClick={() => toggleVisibility(s)}
                      disabled={s.status !== "ready" && s.visibility !== "published"}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        s.visibility === "published"
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "border border-zinc-200 text-zinc-500 hover:border-zinc-400 hover:text-zinc-900"
                      }`}
                    >
                      {s.visibility === "published" ? "Published" : "Draft — publish"}
                    </button>
                    <div className="flex flex-wrap items-center justify-end gap-2.5">
                      <label
                        className="flex items-center gap-1 text-xs text-zinc-400"
                        title="Prezzo di sblocco codice (vuoto = gratis)"
                      >
                        €
                        <input
                          type="text"
                          inputMode="decimal"
                          defaultValue={s.price ? (s.price / 100).toString() : ""}
                          placeholder="free"
                          onBlur={(e) => setPrice(s, e.target.value)}
                          className="w-14 rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700 outline-none focus:border-zinc-400"
                        />
                      </label>
                      <Link
                        href={`/admin/sites/${s.id}`}
                        className="flex items-center gap-1 whitespace-nowrap text-xs text-zinc-400 transition hover:text-zinc-900"
                        title="Sezioni: cattura, ricostruzione, QA"
                      >
                        Sections →
                      </Link>
                      <button
                        onClick={() => setMediaSite(s)}
                        className="flex items-center gap-1 text-xs text-zinc-400 transition hover:text-zinc-900"
                        title="Edit cover & media"
                      >
                        <ImageIcon />
                        Media
                      </button>
                      <span
                        className="flex items-center gap-1 text-xs text-zinc-400"
                        title="Chat intents (fake door)"
                      >
                        <ChatBubbleIcon />
                        {s.chatIntents}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {mediaSite && (
        <MediaModal
          site={mediaSite}
          onClose={() => setMediaSite(null)}
          onSaved={load}
        />
      )}
    </main>
  );
}

// ---------- Media modal: cover del sito + cover dei componenti ----------

async function uploadMedia(
  file: File
): Promise<{ url: string; coverType: "image" | "video" }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Upload fallito (${res.status})`);
  }
  return res.json();
}

function guessCoverType(url: string): "image" | "video" {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) ? "video" : "image";
}

function CoverPreview({
  url,
  coverType,
}: {
  url: string | null;
  coverType?: "image" | "video" | null;
}) {
  if (!url) {
    return (
      <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-zinc-200 text-zinc-300">
        <ImageIcon />
      </div>
    );
  }
  const type = coverType ?? guessCoverType(url);
  return type === "video" ? (
    <video
      src={url}
      className="h-14 w-24 shrink-0 rounded-lg border border-zinc-200 object-cover"
      muted
      loop
      autoPlay
      playsInline
    />
  ) : (
    <img
      src={url}
      alt="cover"
      className="h-14 w-24 shrink-0 rounded-lg border border-zinc-200 object-cover object-top"
    />
  );
}

function CoverEditor({
  label,
  url,
  coverType,
  allowVideo,
  onChange,
  onSave,
  saving,
  saved,
}: {
  label: string;
  url: string;
  coverType: "image" | "video" | null;
  allowVideo: boolean;
  onChange: (url: string, coverType: "image" | "video" | null) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await uploadMedia(file);
      onChange(res.url, res.coverType);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload fallito");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <CoverPreview url={url || null} coverType={coverType} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900">{label}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            value={url}
            onChange={(e) =>
              onChange(
                e.target.value,
                e.target.value ? guessCoverType(e.target.value) : null
              )
            }
            placeholder={allowVideo ? "https://… (immagine o video)" : "https://… (immagine)"}
            className="w-full min-w-0 flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-900 outline-none placeholder:text-zinc-300 focus:border-zinc-400"
          />
          <label className="shrink-0 cursor-pointer rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 transition hover:border-zinc-400">
            {uploading ? "Uploading…" : "Upload"}
            <input
              type="file"
              accept={allowVideo ? "image/*,video/*" : "image/*"}
              className="hidden"
              disabled={uploading}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>
          <button
            onClick={onSave}
            disabled={saving || uploading}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function MediaModal({
  site,
  onClose,
  onSaved,
}: {
  site: AdminSite;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [components, setComponents] = useState<MediaComponent[] | null>(null);
  const [siteCover, setSiteCover] = useState(site.cover ?? "");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sites/${site.slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setComponents(data.components));
  }, [site.slug]);

  function markSaved(id: string) {
    setSavedId(id);
    setTimeout(() => setSavedId((s) => (s === id ? null : s)), 2000);
  }

  async function saveSiteCover() {
    setSavingId("site");
    try {
      await fetch(`/api/admin/sites/${site.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cover: siteCover.trim() || null }),
      });
      markSaved("site");
      onSaved();
    } finally {
      setSavingId(null);
    }
  }

  async function saveComponentCover(c: MediaComponent) {
    setSavingId(c.id);
    try {
      await fetch(`/api/admin/sites/${site.id}/components/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cover: c.cover?.trim() || null,
          coverType: c.cover?.trim() ? c.coverType ?? guessCoverType(c.cover) : null,
        }),
      });
      markSaved(c.id);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-200 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <h3 className="font-semibold text-zinc-900">
            Media — <span className="font-normal text-zinc-500">{site.name}</span>
          </h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-900">
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-xs font-medium uppercase tracking-widest text-zinc-400">
            Cover del sito
          </h4>
          <p className="mt-1 text-xs text-zinc-400">
            Mostrata nella galleria al posto dello screenshot automatico. Solo immagini.
          </p>
          <CoverEditor
            label={siteCover ? "Cover personalizzata" : "Nessuna cover — uso lo screenshot"}
            url={siteCover}
            coverType="image"
            allowVideo={false}
            onChange={(url) => setSiteCover(url)}
            onSave={saveSiteCover}
            saving={savingId === "site"}
            saved={savedId === "site"}
          />

          <h4 className="mt-5 border-t border-zinc-100 pt-4 text-xs font-medium uppercase tracking-widest text-zinc-400">
            Cover dei componenti
          </h4>
          <p className="mt-1 text-xs text-zinc-400">
            Foto o video mostrati sulla card del componente al posto del placeholder.
          </p>

          {!components && <p className="mt-3 text-sm text-zinc-400">Loading…</p>}
          {components?.length === 0 && (
            <p className="mt-3 text-sm text-zinc-400">Nessun componente per questo sito.</p>
          )}

          <div className="divide-y divide-zinc-100">
            {components?.map((c) => (
              <CoverEditor
                key={c.id}
                label={`${c.name} · ${c.kind}`}
                url={c.cover ?? ""}
                coverType={c.coverType}
                allowVideo
                onChange={(url, coverType) =>
                  setComponents((all) =>
                    all
                      ? all.map((x) =>
                          x.id === c.id ? { ...x, cover: url, coverType } : x
                        )
                      : all
                  )
                }
                onSave={() => saveComponentCover(c)}
                saving={savingId === c.id}
                saved={savedId === c.id}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
