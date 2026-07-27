"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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
  loading: "Apro la pagina…",
  filmstriping: "Catturo la filmstrip di scroll…",
  scrolling: "Scrollo la pagina per far scattare le reveal animation…",
  detecting: "Rilevo le sezioni…",
  shooting: "Catturo gli screenshot…",
  labeling: "Etichetto le sezioni (LLM)…",
  saving: "Salvo le sezioni e la descrizione del movimento…",
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
  // Azione appena lanciata dal client, in attesa che il server la confermi
  // come "in corso" — copre la finestra tra POST 202 e il primo onProgress
  // reale (es. avvio del browser Playwright), durante la quale una singola
  // lettura di stato mostrerebbe ancora tutto null.
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
        setLoadError(body?.error ?? `Impossibile caricare il sito (HTTP ${res.status})`);
        return;
      }
      setLoadError(null);
      setSite(await res.json());
    } catch {
      setLoadError("Impossibile raggiungere il server. È in esecuzione npm run dev?");
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

  const busy = !!progress.capturing || !!progress.reconstructing;

  // Poll finché il server conferma una pipeline in corso, O finché un'azione
  // è stata appena lanciata dal client ma il server non l'ha ancora
  // "vista" (pendingKind): senza questo secondo caso, un poll che arriva
  // prima del primo onProgress reale (es. Playwright non ha ancora finito
  // di avviare il browser) mostrerebbe tutto null e il loop di polling non
  // partirebbe mai, lasciando la UI bloccata in silenzio.
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

  // Traccia se il server ha mai confermato l'azione in corso, e chiude
  // pendingKind quando l'azione risulta conclusa (o va in timeout).
  useEffect(() => {
    if (!pendingKind) return;

    if (busy) {
      everBusySeenRef.current = true;
      return;
    }

    if (everBusySeenRef.current) {
      // Era partita e ora il server dice che non è più in corso: finita.
      setPendingKind(null);
      everBusySeenRef.current = false;
      loadSite();
      loadSections();
      return;
    }

    if (Date.now() - pendingSinceRef.current > PENDING_TIMEOUT_MS) {
      setPendingKind(null);
      setActionError(
        "Non risulta partita dopo 30s. Controlla il terminale locale (npm run dev) per errori."
      );
    }
  }, [pendingKind, busy, progress, loadSite, loadSections]);

  async function runAction(kind: "capture" | "reconstruct") {
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/sites/${id}/sections/${kind}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(body?.error ?? "Operazione fallita");
        return;
      }
      everBusySeenRef.current = false;
      pendingSinceRef.current = Date.now();
      setPendingKind(kind);
      // Il lavoro vero gira in background: comincia subito a fare polling.
      loadProgress();
    } catch {
      setActionError("Impossibile raggiungere il server.");
    }
  }

  // Se manca lo schema (utente scrive "example.com" invece di "https://…"),
  // z.string().url() lato server rifiuta con 400 — meglio normalizzare qui
  // che far fallire silenziosamente il salvataggio.
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
      setActionError(body?.error ? JSON.stringify(body.error) : `Salvataggio fallito (HTTP ${res.status})`);
      await loadSite(); // torna al valore reale, l'update ottimistico era sbagliato
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
      setActionError(body?.error ? JSON.stringify(body.error) : `Salvataggio fallito (HTTP ${res.status})`);
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
          Riprova
        </button>
      </div>
    );
  }

  if (!site) {
    return <div className="p-8 text-sm text-gray-500">Caricamento…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-800">
        ← Torna alla dashboard
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
            Studio di ricostruzione →
          </Link>
          <button
            onClick={() => runAction("capture")}
            disabled={busy || pendingKind !== null || site.sourceType !== "url"}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {progress.capturing || pendingKind === "capture" ? "Cattura in corso…" : "Cattura sezioni"}
          </button>
          {sections.some((s) => s.status === "captured") && (
            <Link
              href={`/admin/sites/${id}/boundaries`}
              className="rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-white"
            >
              Rivedi confini ({sections.filter((s) => s.status === "captured").length})
            </Link>
          )}
          <button
            onClick={() => runAction("reconstruct")}
            disabled={busy || pendingKind !== null || sections.length === 0}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {progress.reconstructing || pendingKind === "reconstruct" ? "Ricostruzione in corso…" : "Ricostruisci tutte"}
          </button>
        </div>
      </div>

      {actionError && (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      )}

      {/* Schermata discorsiva: cosa sta succedendo, in tempo reale */}
      {pendingKind && !busy && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-gray-900" />
            <p className="text-sm font-medium text-gray-900">
              {pendingKind === "capture" ? "Avvio il browser (Playwright)…" : "Avvio la ricostruzione…"}
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
              {progress.capturing.found ?? 0} / {progress.capturing.total} sezioni
            </p>
          ) : null}
        </div>
      )}

      {progress.reconstructing && (
        <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-violet-900">
              Ricostruzione {progress.reconstructing.done}/{progress.reconstructing.total}
              {progress.reconstructing.current ? ` — in corso: "${progress.reconstructing.current}"` : ""}
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
            Ogni sezione può richiedere fino a 3 tentativi (chiamate LLM + render locale): può volerci qualche minuto.
          </p>
        </div>
      )}

      {progress.error && (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {busy ? "Errore su una sezione (il resto continua): " : "Ultimo errore: "}
          {progress.error}
        </p>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Preview live</h2>
          <p className="mt-1 text-xs text-gray-400">
            URL del sito deployato — usato anche come fallback per lo screenshot di copertina se il dev server locale non parte.
          </p>
          <input
            type="url"
            defaultValue={site.deployedUrl ?? ""}
            placeholder="https://tuo-sito-deployato.vercel.app"
            onBlur={(e) => saveSiteField({ deployedUrl: normalizeUrl(e.target.value) })}
            className="mt-3 w-full max-w-md rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
          />
          {site.deployedUrl && (
            <iframe
              src={site.deployedUrl}
              className="mt-4 h-140 w-full rounded-md border border-gray-200"
              title="Preview live"
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
            placeholder="Descrizione del progetto (generata dall'AI, modificabile a mano)"
            onBlur={(e) => saveSiteField({ description: e.target.value.trim() || null })}
            className="mt-3 w-full rounded-md border border-gray-200 p-3 text-sm text-gray-800 outline-none focus:border-gray-400"
          />
        </div>
      )}

      {site.sourceType === "git" && (
        <div className="mt-6 rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Cover del progetto</h2>
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
            Componenti estratti{" "}
            <span className="font-normal text-gray-400">
              {site.components.length} totali · {site.components.filter((c) => !c.excluded).length} in vetrina
            </span>
          </h2>
          <div className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
            {site.components.length === 0 && (
              <p className="p-6 text-sm text-gray-500">Nessun componente estratto ancora.</p>
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
                    placeholder="cover URL manuale (override preview)"
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
                  In vetrina pubblica
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center gap-2 text-sm text-gray-500">
        <span>Ordina per:</span>
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
            {progress.capturing ? "Cattura in corso, le sezioni compariranno a breve…" : "Nessuna sezione catturata ancora."}
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
