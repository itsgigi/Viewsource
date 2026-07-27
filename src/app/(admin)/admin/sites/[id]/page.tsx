"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface AwwwardsData {
  url: string;
  title: string;
  award: string | null;
  awardDate: string | null;
  tags: string[];
}

interface SiteDetail {
  id: string;
  name: string;
  slug: string;
  sourceType: "url" | "git";
  sourceUrl: string;
  license: string | null;
  description: string | null;
  cover: string | null;
  deployedUrl: string | null;
  awwwardsUrl: string | null;
  awwwards: AwwwardsData | null;
  _count: { sections: number };
  components: ComponentRow[];
}

interface ComponentRow {
  id: string;
  name: string;
  kind: "layout" | "section" | "ui" | "animation";
  description: string;
  origin: string;
  filePath: string | null;
  previewImage: string | null;
  cover: string | null;
  rank: number | null;
  excluded: boolean;
}

interface SectionRow {
  id: string;
  order: number;
  name: string;
  sourceScreenshot: string;
  renderScreenshot: string | null;
  diffScore: number | null;
  status: "captured" | "pending" | "generated" | "approved" | "rejected";
}

interface CaptureProgress {
  stage: "loading" | "filmstriping" | "scrolling" | "detecting" | "shooting" | "labeling" | "saving";
  found?: number;
  total?: number;
}

interface ReconstructProgress {
  total: number;
  done: number;
  current: string | null;
}

interface PipelineProgress {
  capturing: CaptureProgress | null;
  reconstructing: ReconstructProgress | null;
  error: string | null;
}

type SortKey = "diffScore" | "order" | "name" | "status";

const STATUS_STYLE: Record<SectionRow["status"], string> = {
  captured: "bg-violet-50 text-violet-700",
  pending: "bg-amber-50 text-amber-700",
  generated: "bg-blue-50 text-blue-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
};

const CAPTURE_STAGE_LABEL: Record<CaptureProgress["stage"], string> = {
  loading: "Opening the page…",
  filmstriping: "Capturing the scroll filmstrip…",
  scrolling: "Scrolling the page to trigger reveal animations…",
  detecting: "Detecting sections…",
  shooting: "Capturing screenshots…",
  labeling: "Labeling sections (LLM)…",
  saving: "Saving sections and the motion description…",
};

const KIND_BADGE: Record<ComponentRow["kind"], string> = {
  layout: "bg-blue-50 text-blue-700",
  section: "bg-violet-50 text-violet-700",
  ui: "bg-emerald-50 text-emerald-700",
  animation: "bg-orange-50 text-orange-700",
};

function diffBadge(score: number | null): { style: string; label: string } {
  if (score === null) return { style: "bg-gray-100 text-gray-500", label: "—" };
  const label = `${(score * 100).toFixed(1)}%`;
  if (score <= 0.05) return { style: "bg-emerald-50 text-emerald-700", label };
  if (score <= 0.1) return { style: "bg-lime-50 text-lime-700", label };
  if (score <= 0.2) return { style: "bg-amber-50 text-amber-700", label };
  return { style: "bg-red-50 text-red-700", label };
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("diffScore");
  const [progress, setProgress] = useState<PipelineProgress>({
    capturing: null,
    reconstructing: null,
    error: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [awwwardsUrlInput, setAwwwardsUrlInput] = useState("");
  const [awwwardsFetching, setAwwwardsFetching] = useState(false);
  // Action just fired by the client, waiting for the server to confirm it
  // as "in progress" — covers the window between the POST 202 and the first
  // real onProgress (e.g. Playwright still launching the browser), during
  // which a single status read would still show everything as null.
  const [pendingKind, setPendingKind] = useState<"capture" | "reconstruct" | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const everBusySeenRef = useRef(false);
  const pendingSinceRef = useRef(0);

  const PENDING_TIMEOUT_MS = 30_000;

  const loadSite = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/sites/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLoadError(body?.error ?? `Failed to load the site (HTTP ${res.status})`);
        return;
      }
      setLoadError(null);
      setSite(await res.json());
    } catch {
      setLoadError("Could not reach the server. Is npm run dev running?");
    }
  }, [id]);

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/admin/sites/${id}/sections`);
    if (res.ok) setSections((await res.json()).sections);
  }, [id]);

  const loadProgress = useCallback(async () => {
    const res = await fetch(`/api/admin/sites/${id}/sections/status`);
    if (res.ok) setProgress(await res.json());
  }, [id]);

  useEffect(() => {
    loadSite();
    loadSections();
    loadProgress();
  }, [loadSite, loadSections, loadProgress]);

  // Seed the input once from the loaded site; afterwards the input is the
  // user's source of truth until they fetch again.
  useEffect(() => {
    if (site) setAwwwardsUrlInput((cur) => cur || site.awwwardsUrl || "");
  }, [site]);

  const busy = !!progress.capturing || !!progress.reconstructing;

  // Poll while the server confirms a pipeline in progress, OR while an
  // action was just fired by the client but the server hasn't "seen" it
  // yet (pendingKind): without this second case, a poll that arrives before
  // the first real onProgress (e.g. Playwright hasn't finished launching
  // the browser yet) would show everything as null and the polling loop
  // would never start, leaving the UI silently stuck.
  useEffect(() => {
    if (!busy && !pendingKind) return;

    pollRef.current = setInterval(async () => {
      await loadProgress();
      loadSections();
    }, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [busy, pendingKind, loadProgress, loadSections]);

  // Tracks whether the server has ever confirmed the action is running, and
  // clears pendingKind once the action is done (or times out).
  useEffect(() => {
    if (!pendingKind) return;

    if (busy) {
      everBusySeenRef.current = true;
      return;
    }

    if (everBusySeenRef.current) {
      // It had started and now the server says it's no longer running: done.
      setPendingKind(null);
      everBusySeenRef.current = false;
      loadSite();
      loadSections();
      return;
    }

    if (Date.now() - pendingSinceRef.current > PENDING_TIMEOUT_MS) {
      setPendingKind(null);
      setActionError(
        "Doesn't appear to have started after 30s. Check the local terminal (npm run dev) for errors."
      );
    }
  }, [pendingKind, busy, progress, loadSite, loadSections]);

  async function runAction(kind: "capture" | "reconstruct") {
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/sites/${id}/sections/${kind}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(body?.error ?? "Operation failed");
        return;
      }
      everBusySeenRef.current = false;
      pendingSinceRef.current = Date.now();
      setPendingKind(kind);
      // The real work runs in the background: start polling right away.
      loadProgress();
    } catch {
      setActionError("Could not reach the server.");
    }
  }

  // If the scheme is missing (user types "example.com" instead of
  // "https://…"), z.string().url() on the server rejects with 400 — better
  // to normalize here than let the save silently fail.
  function normalizeUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  async function saveSiteField(patch: Partial<Pick<SiteDetail, "description" | "cover" | "deployedUrl">>) {
    setActionError(null);
    setSite((s) => (s ? { ...s, ...patch } : s));
    const res = await fetch(`/api/admin/sites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setActionError(body?.error ? JSON.stringify(body.error) : `Save failed (HTTP ${res.status})`);
      await loadSite(); // revert to the real value, the optimistic update was wrong
    }
  }

  async function fetchAwwwards() {
    setActionError(null);
    setAwwwardsFetching(true);
    try {
      const res = await fetch(`/api/admin/sites/${id}/awwwards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ awwwardsUrl: awwwardsUrlInput.trim() || null }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(body?.error ?? `Awwwards fetch failed (HTTP ${res.status})`);
        return;
      }
      // The awwwards route returns a plain Site row (no `components`/`_count`
      // relations) — merge just the changed fields instead of replacing the
      // whole object, or those relations would vanish from state.
      setSite((s) => (s ? { ...s, awwwardsUrl: body.awwwardsUrl, awwwards: body.awwwards } : s));
    } finally {
      setAwwwardsFetching(false);
    }
  }

  async function saveComponentCover(c: ComponentRow, coverInput: string) {
    const cover = normalizeUrl(coverInput);
    setActionError(null);
    setSite((s) =>
      s ? { ...s, components: s.components.map((x) => (x.id === c.id ? { ...x, cover } : x)) } : s
    );
    const res = await fetch(`/api/admin/sites/${id}/components/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cover, coverType: cover ? "image" : null }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setActionError(body?.error ? JSON.stringify(body.error) : `Save failed (HTTP ${res.status})`);
      await loadSite();
    }
  }

  async function toggleComponentExcluded(c: ComponentRow) {
    const excluded = !c.excluded;
    setSite((s) =>
      s ? { ...s, components: s.components.map((x) => (x.id === c.id ? { ...x, excluded } : x)) } : s
    );
    await fetch(`/api/admin/sites/${id}/components/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded }),
    });
  }

  const sorted = [...sections].sort((a, b) => {
    switch (sortKey) {
      case "diffScore":
        return (b.diffScore ?? -1) - (a.diffScore ?? -1);
      case "order":
        return a.order - b.order;
      case "name":
        return a.name.localeCompare(b.name);
      case "status":
        return a.status.localeCompare(b.status);
      default:
        return 0;
    }
  });

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <p className="rounded-md bg-red-50 p-4 text-sm text-red-700">{loadError}</p>
        <button
          onClick={loadSite}
          className="mt-3 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!site) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-800">
        ← Back to dashboard
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{site.name}</h1>
          <p className="text-sm text-gray-500">{site.sourceUrl}</p>
          {site.sourceType === "git" && (
            <p className="mt-1 text-xs text-gray-400">License: {site.license ?? "all rights reserved"}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href={`/admin/sites/${id}/reconstruction`}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white"
          >
            Reconstruction studio →
          </Link>
          <button
            onClick={() => runAction("capture")}
            disabled={busy || pendingKind !== null || site.sourceType !== "url"}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {progress.capturing || pendingKind === "capture" ? "Capturing…" : "Capture sections"}
          </button>
          {sections.some((s) => s.status === "captured") && (
            <Link
              href={`/admin/sites/${id}/boundaries`}
              className="rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-white"
            >
              Review boundaries ({sections.filter((s) => s.status === "captured").length})
            </Link>
          )}
          <button
            onClick={() => runAction("reconstruct")}
            disabled={busy || pendingKind !== null || sections.length === 0}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {progress.reconstructing || pendingKind === "reconstruct" ? "Reconstructing…" : "Reconstruct all"}
          </button>
        </div>
      </div>

      {actionError && (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      )}

      {/* Narrative status: what's happening, in real time */}
      {pendingKind && !busy && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-gray-900" />
            <p className="text-sm font-medium text-gray-900">
              {pendingKind === "capture" ? "Launching the browser (Playwright)…" : "Starting the reconstruction…"}
            </p>
          </div>
        </div>
      )}
      {progress.capturing && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-gray-900" />
            <p className="text-sm font-medium text-gray-900">
              {CAPTURE_STAGE_LABEL[progress.capturing.stage]}
            </p>
          </div>
          {progress.capturing.stage === "shooting" && progress.capturing.total ? (
            <p className="mt-1 text-xs text-gray-500">
              {progress.capturing.found ?? 0} / {progress.capturing.total} sections
            </p>
          ) : null}
        </div>
      )}

      {progress.reconstructing && (
        <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-violet-900">
              Reconstructing {progress.reconstructing.done}/{progress.reconstructing.total}
              {progress.reconstructing.current ? ` — in progress: "${progress.reconstructing.current}"` : ""}
            </p>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-violet-100">
            <div
              className="h-full rounded-full bg-violet-600 transition-all"
              style={{
                width: `${
                  progress.reconstructing.total
                    ? (progress.reconstructing.done / progress.reconstructing.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="mt-1 text-xs text-violet-500">
            Each section can take up to 3 attempts (LLM calls + local render): it can take a few minutes.
          </p>
        </div>
      )}

      {progress.error && (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {busy ? "Error on one section (the rest continues): " : "Last error: "}
          {progress.error}
        </p>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Live preview</h2>
          <p className="mt-1 text-xs text-gray-400">
            URL of the deployed site — also used as a fallback for the cover screenshot if the local dev server doesn't start.
          </p>
          <input
            type="url"
            defaultValue={site.deployedUrl ?? ""}
            placeholder="https://your-deployed-site.vercel.app"
            onBlur={(e) => saveSiteField({ deployedUrl: normalizeUrl(e.target.value) })}
            className="mt-3 w-full max-w-md rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
          />
          {site.deployedUrl && (
            <iframe
              src={site.deployedUrl}
              className="mt-4 h-140 w-full rounded-md border border-gray-200"
              title="Live preview"
            />
          )}
        </div>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">AI Analysis</h2>
          <textarea
            defaultValue={site.description ?? ""}
            rows={6}
            placeholder="Project description (AI-generated, editable by hand)"
            onBlur={(e) => saveSiteField({ description: e.target.value.trim() || null })}
            className="mt-3 w-full rounded-md border border-gray-200 p-3 text-sm text-gray-800 outline-none focus:border-gray-400"
          />
        </div>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Awwwards</h2>
          <p className="mt-1 text-xs text-gray-400">
            Repo sites have no live URL to auto-discover from — paste the site&apos;s Awwwards page
            (or leave empty to try auto-discovery from the deployed URL above) and fetch its info.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="url"
              value={awwwardsUrlInput}
              onChange={(e) => setAwwwardsUrlInput(e.target.value)}
              placeholder="https://www.awwwards.com/sites/…"
              className="w-full max-w-md rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
            />
            <button
              onClick={fetchAwwwards}
              disabled={awwwardsFetching}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {awwwardsFetching ? "Fetching…" : "Fetch info"}
            </button>
          </div>
          {site.awwwards && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
              {site.awwwards.award && (
                <span className="rounded-full bg-gray-900 px-2.5 py-1 font-medium text-white">
                  🏆 {site.awwwards.award}
                </span>
              )}
              {site.awwwards.tags?.slice(0, 6).map((t) => (
                <span key={t} className="rounded-full border border-gray-200 px-2 py-0.5">
                  {t}
                </span>
              ))}
              <a
                href={site.awwwards.url}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 underline-offset-2 hover:text-gray-700 hover:underline"
              >
                View on awwwards.com ↗
              </a>
            </div>
          )}
        </div>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Project cover</h2>
          <div className="mt-3 flex items-center gap-3">
            {site.cover && (
              <img src={site.cover} alt="cover" className="h-14 w-24 shrink-0 rounded object-cover object-top" />
            )}
            <input
              type="url"
              defaultValue={site.cover ?? ""}
              placeholder="https://…"
              onBlur={(e) => saveSiteField({ cover: normalizeUrl(e.target.value) })}
              className="w-full max-w-md rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
            />
          </div>
        </div>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-gray-900">
            Extracted components{" "}
            <span className="font-normal text-gray-400">
              {site.components.length} total · {site.components.filter((c) => !c.excluded).length} showcased
            </span>
          </h2>
          <div className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
            {site.components.length === 0 && (
              <p className="p-6 text-sm text-gray-500">No components extracted yet.</p>
            )}
            {site.components.map((c) => (
              <div key={c.id} className="flex items-center gap-4 p-3">
                {c.previewImage || c.cover ? (
                  <img
                    src={c.previewImage ?? c.cover ?? undefined}
                    alt={c.name}
                    className="h-14 w-24 shrink-0 rounded object-cover object-top"
                  />
                ) : (
                  <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
                    no preview
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-gray-900">{c.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE[c.kind]}`}>
                      {c.kind}
                    </span>
                    {c.rank !== null && <span className="shrink-0 text-xs text-gray-400">#{c.rank}</span>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-gray-400">{c.filePath}</p>
                  <input
                    type="url"
                    defaultValue={c.cover ?? ""}
                    placeholder="manual cover URL (overrides preview)"
                    onBlur={(e) => saveComponentCover(c, e.target.value)}
                    className="mt-1.5 w-full max-w-xs rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 outline-none placeholder:text-gray-300 focus:border-gray-400"
                  />
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={!c.excluded}
                    onChange={() => toggleComponentExcluded(c)}
                  />
                  In public showcase
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center gap-2 text-sm text-gray-500">
        <span>Sort by:</span>
        {(["diffScore", "order", "name", "status"] as SortKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setSortKey(key)}
            className={`rounded-full px-2.5 py-1 ${
              sortKey === key ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="mt-4 divide-y divide-gray-100 rounded-lg border border-gray-100">
        {sorted.length === 0 && (
          <p className="p-6 text-sm text-gray-500">
            {progress.capturing ? "Capturing in progress, sections will appear shortly…" : "No sections captured yet."}
          </p>
        )}
        {sorted.map((s) => {
          const badge = diffBadge(s.diffScore);
          return (
            <Link
              key={s.id}
              href={`/admin/sites/${id}/sections/${s.id}`}
              className="flex items-center gap-4 p-3 hover:bg-gray-50"
            >
              <img
                src={s.sourceScreenshot}
                alt={s.name}
                className="h-14 w-24 rounded object-cover object-top"
              />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{s.name}</p>
                <p className="text-xs text-gray-400">#{s.order}</p>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[s.status]}`}>
                {s.status}
              </span>
              <span className={`w-16 rounded-full px-2 py-1 text-center text-xs font-medium ${badge.style}`}>
                {badge.label}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
