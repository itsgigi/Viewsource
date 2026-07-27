"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface ReconstructionFrame {
  file: string;
  timestampMs: number;
}

interface ReconstructionSectionMeta {
  file: string;
  name: string;
  approved: boolean;
  referenceFrame: string | null;
}

interface ReconstructionMeta {
  slug: string;
  siteId: string;
  sourceUrl: string;
  phase: "collecting" | "analyzed" | "generated" | "refining" | "published";
  detectedLibs: string[];
  palette: string[];
  fonts: string[];
  video: { human: string | null; scripted: string | null };
  frames: ReconstructionFrame[];
  sections: ReconstructionSectionMeta[];
}

interface SectionPublishState {
  file: string;
  name: string;
  approved: boolean;
  published: boolean;
  aligned: boolean;
}

interface Progress {
  running: { stage: string; detail?: string } | null;
  error: string | null;
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const PHASE_LABEL: Record<ReconstructionMeta["phase"], string> = {
  collecting: "Raccolta materiale",
  analyzed: "Analisi confermata",
  generated: "Demo generata",
  refining: "In rifinitura",
  published: "Pubblicato",
};

export default function ReconstructionPage() {
  const { id } = useParams<{ id: string }>();
  const [siteName, setSiteName] = useState<string>("");
  const [meta, setMeta] = useState<ReconstructionMeta | null>(null);
  const [publishState, setPublishState] = useState<SectionPublishState[]>([]);
  const [progress, setProgress] = useState<Progress>({ running: null, error: null });
  const [specContent, setSpecContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [publishSummary, setPublishSummary] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<
    Record<string, { diffScore: number; diffImageUrl: string; renderImageUrl: string } | { error: string }>
  >({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const [siteRes, reconRes] = await Promise.all([
      fetch(`/api/admin/sites/${id}`),
      fetch(`/api/admin/sites/${id}/reconstruction`),
    ]);
    if (siteRes.ok) setSiteName((await siteRes.json()).name);
    if (reconRes.ok) {
      const data = await reconRes.json();
      setMeta(data.meta);
      setPublishState(data.publishState ?? []);
      if (data.meta?.phase === "generated" || data.meta?.phase === "refining" || data.meta?.phase === "published") {
        fetch(`/api/admin/sites/${id}/reconstruction/preview`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => p && setPreviewUrl(p.url))
          .catch(() => {});
      }
    }
    setLoading(false);
  }, [id]);

  const loadProgress = useCallback(async () => {
    const res = await fetch(`/api/admin/sites/${id}/reconstruction/status`);
    if (res.ok) setProgress(await res.json());
  }, [id]);

  useEffect(() => {
    load();
    loadProgress();
  }, [load, loadProgress]);

  useEffect(() => {
    if (meta?.phase === "analyzed" || meta?.phase === "generated" || meta?.phase === "refining" || meta?.phase === "published") {
      fetch(`/api/admin/sites/${id}/reconstruction/spec`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSpecContent(d.content ?? ""));
    }
  }, [id, meta?.phase]);

  const busy = !!progress.running;
  // `busy` riflette lo stato confermato dal server (poll ogni 1.5s): appena
  // dopo il click c'è una finestra in cui il server non ha ancora scritto
  // `running`, durante la quale `busy` resta false. `busyAction` è settato
  // sincrono al click — usarlo insieme a `busy` chiude quel buco (bottoni
  // bloccati e loader visibili da subito, non solo dopo il primo poll).
  const anyBusy = busy || !!busyAction;

  useEffect(() => {
    if (!busy && !busyAction) return;
    pollRef.current = setInterval(async () => {
      await loadProgress();
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [busy, busyAction, loadProgress]);

  useEffect(() => {
    if (!busy && busyAction) {
      setBusyAction(null);
      load();
    }
  }, [busy, busyAction, load]);

  async function start() {
    setBusyAction("start");
    await fetch(`/api/admin/sites/${id}/reconstruction`, { method: "POST" });
    setBusyAction(null);
    await load();
  }

  async function uploadHumanVideo(file: File) {
    setBusyAction("upload-video");
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`/api/admin/sites/${id}/reconstruction/video`, { method: "POST", body: fd });
    setBusyAction(null);
    await load();
  }

  async function fireAndPoll(path: string, body?: unknown) {
    setBusyAction(path);
    await fetch(`/api/admin/sites/${id}/reconstruction/${path}`, {
      method: "POST",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    await loadProgress();
  }

  async function saveSpec(confirm: boolean) {
    setBusyAction("save-spec");
    await fetch(`/api/admin/sites/${id}/reconstruction/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: specContent }),
    });
    setBusyAction(null);
    if (confirm) await load();
  }

  async function toggleApproved(file: string, approved: boolean) {
    await fetch(`/api/admin/sites/${id}/reconstruction/sections/${encodeURIComponent(file)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    await load();
  }

  async function setReferenceFrame(file: string, referenceFrame: string) {
    await fetch(`/api/admin/sites/${id}/reconstruction/sections/${encodeURIComponent(file)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceFrame: referenceFrame || null }),
    });
    await load();
  }

  async function runVerify(section: ReconstructionSectionMeta) {
    if (!section.referenceFrame) return;
    setVerifyResults((v) => ({ ...v, [section.file]: { error: "…" } as { error: string } }));
    const res = await fetch(`/api/admin/sites/${id}/reconstruction/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: section.file, referenceFrame: section.referenceFrame }),
    });
    const data = await res.json();
    setVerifyResults((v) => ({ ...v, [section.file]: res.ok ? data : { error: data.error ?? "Errore" } }));
  }

  async function publish() {
    setBusyAction("publish");
    setPublishSummary(null);
    const res = await fetch(`/api/admin/sites/${id}/reconstruction/publish`, { method: "POST" });
    const data = await res.json();
    setBusyAction(null);
    setPublishSummary(
      res.ok
        ? `Pubblicato: ${data.created} create, ${data.updated} aggiornate, ${data.removed} rimosse, ${data.skipped} invariate.`
        : `Errore: ${data.error}`
    );
    await load();
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Caricamento…</div>;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Link href={`/admin/sites/${id}`} className="text-sm text-gray-500 hover:text-gray-800">
        ← Torna al sito
      </Link>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Studio — {siteName}</h1>
          <p className="text-sm text-gray-500">Ricostruzione assistita, file veri in /reconstructions/{meta?.slug ?? "…"}/</p>
        </div>
        {meta && (
          <span className="shrink-0 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
            {PHASE_LABEL[meta.phase]}
          </span>
        )}
      </div>

      {progress.error && (
        <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{progress.error}</p>
      )}
      {anyBusy && (
        <p className="mt-4 flex items-center gap-2 rounded-md bg-gray-50 p-3 text-sm text-gray-700">
          <Spinner />
          {progress.running
            ? `In corso: ${progress.running.stage}${progress.running.detail ? ` — ${progress.running.detail}` : ""}`
            : "Avvio…"}
        </p>
      )}

      {!meta && (
        <button
          onClick={start}
          disabled={busyAction === "start"}
          className="mt-6 flex items-center gap-1.5 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busyAction === "start" && <Spinner />}
          Avvia ricostruzione
        </button>
      )}

      {meta && (
        <>
          {/* Fase 1: raccolta */}
          <section className="mt-8 rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900">Fase 1 — Raccolta materiale</h2>

            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <label
                className={`flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-gray-700 hover:border-gray-400 ${
                  anyBusy ? "pointer-events-none opacity-40" : "cursor-pointer"
                }`}
              >
                {busyAction === "upload-video" && <Spinner />}
                {meta.video.human ? "Video umano ✓ (ricarica)" : "Carica video umano"}
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={anyBusy}
                  onChange={(e) => e.target.files?.[0] && uploadHumanVideo(e.target.files[0])}
                />
              </label>

              <button
                onClick={() => fireAndPoll("video/scripted")}
                disabled={anyBusy}
                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-gray-700 hover:border-gray-400 disabled:opacity-40"
              >
                {busyAction === "video/scripted" && <Spinner />}
                {meta.video.scripted ? "Video scriptato ✓ (rigenera)" : "Genera video scriptato"}
              </button>

              <button
                onClick={() => fireAndPoll("frames", { source: meta.video.scripted ? "scripted" : "human" })}
                disabled={anyBusy || (!meta.video.human && !meta.video.scripted)}
                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-gray-700 hover:border-gray-400 disabled:opacity-40"
              >
                {busyAction === "frames" && <Spinner />}
                Estrai frame ({meta.frames.length})
              </button>

              <button
                onClick={() => fireAndPoll("static")}
                disabled={anyBusy}
                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-gray-700 hover:border-gray-400 disabled:opacity-40"
              >
                {busyAction === "static" && <Spinner />}
                Estrai dati statici
              </button>
            </div>

            {meta.frames.length > 0 && (
              <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                {meta.frames.map((f) => (
                  <div key={f.file} className="shrink-0 text-center">
                    <img
                      src={`/api/admin/sites/${id}/reconstruction/frames/${f.file}`}
                      alt={f.file}
                      className="h-20 w-32 rounded border border-gray-200 object-cover"
                    />
                    <p className="mt-1 text-[10px] text-gray-400">{(f.timestampMs / 1000).toFixed(1)}s</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Fase 2: analisi */}
          <section className="mt-6 rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900">Fase 2 — Analisi</h2>

            <button
              onClick={() => fireAndPoll("analyze")}
              disabled={anyBusy || meta.frames.length === 0}
              className="mt-3 flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:border-gray-400 disabled:opacity-40"
            >
              {busyAction === "analyze" && <Spinner />}
              Analizza (vision)
            </button>

            {(specContent || meta.phase !== "collecting") && (
              <div className="mt-3">
                <textarea
                  value={specContent}
                  onChange={(e) => setSpecContent(e.target.value)}
                  rows={14}
                  className="w-full rounded-md border border-gray-200 p-3 font-mono text-xs text-gray-800 outline-none focus:border-gray-400"
                  placeholder="SPEC.md apparirà qui dopo l'analisi — correggila liberamente prima di confermare."
                />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => saveSpec(false)}
                    disabled={anyBusy}
                    className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:border-gray-400 disabled:opacity-40"
                  >
                    {busyAction === "save-spec" && <Spinner />}
                    Salva bozza
                  </button>
                  <button
                    onClick={() => saveSpec(true)}
                    disabled={anyBusy}
                    className="flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {busyAction === "save-spec" && <Spinner />}
                    Conferma SPEC
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Fase 3: generazione + preview */}
          <section className="mt-6 rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900">Fase 3-4 — Generazione &amp; preview live</h2>

            <button
              onClick={() => fireAndPoll("generate")}
              disabled={anyBusy || meta.phase === "collecting"}
              className="mt-3 flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {busyAction === "generate" && <Spinner />}
              {meta.sections.length > 0 ? "Rigenera demo (sovrascrive i file)" : "Genera demo"}
            </button>

            {previewUrl && (
              <div className="mt-4 overflow-hidden rounded-md border border-gray-200">
                <iframe src={previewUrl} className="h-140 w-full" title="Preview studio" />
              </div>
            )}
          </section>

          {/* Fase 5-6: sezioni, verify, approvazione, publish */}
          {meta.sections.length > 0 && (
            <section className="mt-6 rounded-lg border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-900">Fase 5-6 — Approvazione &amp; pubblicazione</h2>

              <div className="mt-3 divide-y divide-gray-100">
                {meta.sections.map((s) => {
                  const state = publishState.find((p) => p.file === s.file);
                  const verify = verifyResults[s.file];
                  return (
                    <div key={s.file} className="py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-1.5 text-sm text-gray-900">
                          <input
                            type="checkbox"
                            checked={s.approved}
                            onChange={(e) => toggleApproved(s.file, e.target.checked)}
                          />
                          {s.name}
                        </label>
                        <span className="font-mono text-xs text-gray-400">{s.file}</span>

                        {state?.published && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              state.aligned ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {state.aligned ? "allineato" : "modifiche non pubblicate"}
                          </span>
                        )}
                        {!state?.published && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                            non pubblicato
                          </span>
                        )}

                        <select
                          value={s.referenceFrame ?? ""}
                          onChange={(e) => setReferenceFrame(s.file, e.target.value)}
                          className="rounded border border-gray-200 px-2 py-1 text-xs"
                        >
                          <option value="">frame di riferimento…</option>
                          {meta.frames.map((f) => (
                            <option key={f.file} value={f.file}>
                              {f.file} ({(f.timestampMs / 1000).toFixed(1)}s)
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={() => runVerify(s)}
                          disabled={!s.referenceFrame}
                          className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-40"
                        >
                          Verify
                        </button>
                      </div>

                      {verify && "error" in verify && (
                        <p className="mt-1.5 text-xs text-red-600">{verify.error}</p>
                      )}
                      {verify && "diffScore" in verify && (
                        <div className="mt-2 flex items-center gap-3">
                          <span className="text-xs font-medium text-gray-700">
                            diffScore: {(verify.diffScore * 100).toFixed(1)}%
                          </span>
                          <img src={verify.renderImageUrl} alt="render" className="h-16 rounded border border-gray-200" />
                          <img src={verify.diffImageUrl} alt="diff" className="h-16 rounded border border-gray-200" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                onClick={publish}
                disabled={anyBusy || meta.sections.every((s) => !s.approved)}
                className="mt-4 flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {busyAction === "publish" && <Spinner />}
                {busyAction === "publish" ? "Pubblico…" : "Pubblica"}
              </button>
              {publishSummary && <p className="mt-2 text-sm text-gray-700">{publishSummary}</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
