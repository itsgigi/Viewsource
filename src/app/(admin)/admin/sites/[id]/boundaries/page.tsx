"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface SectionRow {
  id: string;
  order: number;
  name: string;
  sourceScreenshot: string;
  status: string;
  boundsTop: number | null;
  boundsHeight: number | null;
}

interface SiteDetail {
  id: string;
  name: string;
  sectionsFullPageScreenshot: string | null;
}

const DISPLAY_WIDTH = 900;

interface DragState {
  id: string;
  edge: "top" | "bottom";
  startClientY: number;
  origTop: number;
  origHeight: number;
}

/**
 * Boundary editor HITL (spec Parte 5a): schermata full-page con i tagli
 * proposti sovrapposti. Unisci/dividi/scarta/rinomina operano su righe
 * Section REALI in stato "captured" (src/lib/sections/boundaries.ts) — non
 * un draft ephemero, così l'editor ha ID stabili da PATCHare.
 *
 * Semplificazione pragmatica rispetto allo spec: "dividere trascinando una
 * linea di taglio" è implementato come click sul punto + conferma (non un
 * drag di una linea nuova da zero) — il drag vero è riservato al
 * ridimensionamento dei bordi esistenti. Più veloce da costruire, stesso
 * risultato funzionale, ancora "pochi click".
 */
export default function BoundariesPage() {
  const { id } = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const [naturalHeight, setNaturalHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPreview, setDragPreview] = useState<{ id: string; top: number; height: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const scale = naturalWidth ? DISPLAY_WIDTH / naturalWidth : 0;

  const load = useCallback(async () => {
    const [siteRes, sectionsRes] = await Promise.all([
      fetch(`/api/admin/sites/${id}`),
      fetch(`/api/admin/sites/${id}/sections`),
    ]);
    if (siteRes.ok) setSite(await siteRes.json());
    if (sectionsRes.ok) {
      const body = await sectionsRes.json();
      setSections(
        (body.sections as SectionRow[])
          .filter((s) => s.status === "captured")
          .sort((a, b) => (a.boundsTop ?? 0) - (b.boundsTop ?? 0))
      );
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Guard sincrono oltre allo state `busy`: due click ravvicinati possono
  // arrivare prima che React re-renderizzi con `busy=true`, e due
  // merge/split/discard/resize concorrenti sullo stesso sito possono
  // scontrarsi (avevamo visto un unique-constraint transitorio prima di
  // rendere il vincolo deferrable — questo guard evita di doverci contare).
  const busyRef = useRef(false);

  const call = useCallback(
    async (path: string, body: unknown) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/sites/${id}/sections/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => null);
          setError(b?.error ?? "Operazione fallita");
          return false;
        }
        await load();
        setSelected([]);
        return true;
      } catch {
        setError("Impossibile raggiungere il server.");
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [id, load]
  );

  function toggleSelect(sectionId: string) {
    setSelected((prev) => {
      if (prev.includes(sectionId)) return prev.filter((x) => x !== sectionId);
      if (prev.length >= 2) return [prev[1], sectionId];
      return [...prev, sectionId];
    });
  }

  async function handleMerge() {
    if (selected.length !== 2) return;
    await call("merge", { idA: selected[0], idB: selected[1] });
  }

  async function handleDiscard(sectionId: string) {
    if (!confirm("Scartare questa sezione? Non è recuperabile.")) return;
    await call("discard", { sectionId });
  }

  function handleBandClick(e: React.MouseEvent<HTMLDivElement>, section: SectionRow) {
    if (dragRef.current || busyRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const pageY = Math.round((section.boundsTop ?? 0) + localY / scale);
    if (!confirm(`Dividere "${section.name}" a questo punto (y≈${pageY}px)?`)) return;
    call("split", { sectionId: section.id, atY: pageY });
  }

  function startDrag(e: React.PointerEvent, section: SectionRow, edge: "top" | "bottom") {
    if (busyRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      id: section.id,
      edge,
      startClientY: e.clientY,
      origTop: section.boundsTop ?? 0,
      origHeight: section.boundsHeight ?? 0,
    };
    setDragPreview({ id: section.id, top: section.boundsTop ?? 0, height: section.boundsHeight ?? 0 });
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  }

  function onDragMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || !scale) return;
    const deltaPagePx = (e.clientY - d.startClientY) / scale;
    if (d.edge === "top") {
      const newTop = Math.max(0, d.origTop + deltaPagePx);
      const newHeight = d.origHeight - (newTop - d.origTop);
      if (newHeight > 20) setDragPreview({ id: d.id, top: newTop, height: newHeight });
    } else {
      const newHeight = Math.max(20, d.origHeight + deltaPagePx);
      setDragPreview({ id: d.id, top: d.origTop, height: newHeight });
    }
  }

  const onDragEnd = useCallback(async () => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    const d = dragRef.current;
    const preview = dragPreview;
    dragRef.current = null;
    setDragPreview(null);
    if (!d || !preview) return;
    await call("resize", {
      sectionId: d.id,
      boundsTop: Math.round(preview.top),
      boundsHeight: Math.round(preview.height),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragPreview, call]);

  async function submitRename(sectionId: string) {
    const name = renameValue.trim();
    setRenaming(null);
    if (!name) return;
    await fetch(`/api/admin/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    load();
  }

  if (!site) {
    return <div className="p-8 text-sm text-gray-500">Caricamento…</div>;
  }

  if (!site.sectionsFullPageScreenshot) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Link href={`/admin/sites/${id}`} className="text-sm text-gray-500 hover:text-gray-800">
          ← Torna al sito
        </Link>
        <p className="mt-4 rounded-md bg-amber-50 p-4 text-sm text-amber-800">
          Nessuno screenshot full-page disponibile: rilancia la cattura sezioni dal sito.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <Link href={`/admin/sites/${id}`} className="text-sm text-gray-500 hover:text-gray-800">
        ← Torna al sito
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Rivedi confini — {site.name}</h1>
          <p className="text-sm text-gray-500">
            Unisci, dividi, scarta o rinomina le sezioni rilevate. Clicca una banda per dividerla, trascina i
            bordi per ridimensionarla, seleziona due bande (checkbox) per unirle.
          </p>
        </div>
        <button
          onClick={handleMerge}
          disabled={selected.length !== 2 || busy}
          className="shrink-0 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Unisci selezionate ({selected.length}/2)
        </button>
      </div>

      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="mt-6 flex gap-6">
        <div
          className="relative shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50"
          style={{ width: DISPLAY_WIDTH, height: naturalHeight && scale ? naturalHeight * scale : undefined }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={site.sectionsFullPageScreenshot}
            alt="Screenshot full-page"
            style={{ width: DISPLAY_WIDTH, display: "block" }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalWidth(img.naturalWidth);
              setNaturalHeight(img.naturalHeight);
            }}
          />

          {scale > 0 &&
            sections.map((s, idx) => {
              const isDragging = dragPreview?.id === s.id;
              const top = isDragging ? dragPreview.top : s.boundsTop ?? 0;
              const height = isDragging ? dragPreview.height : s.boundsHeight ?? 0;
              const isSelected = selected.includes(s.id);
              const hue = idx % 2 === 0 ? "border-violet-400 bg-violet-500/10" : "border-blue-400 bg-blue-500/10";

              return (
                <div
                  key={s.id}
                  onClick={(e) => handleBandClick(e, s)}
                  className={`absolute left-0 w-full cursor-crosshair border-2 ${
                    isSelected ? "border-emerald-500 bg-emerald-500/20" : hue
                  }`}
                  style={{ top: top * scale, height: Math.max(4, height * scale) }}
                  title="Clicca per dividere qui"
                >
                  <div
                    onPointerDown={(e) => startDrag(e, s, "top")}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute -top-1 left-0 h-2 w-full cursor-row-resize"
                  />
                  <div
                    onPointerDown={(e) => startDrag(e, s, "bottom")}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute -bottom-1 left-0 h-2 w-full cursor-row-resize"
                  />

                  <div
                    className="absolute left-1 top-1 flex items-center gap-1.5 rounded bg-white/90 px-1.5 py-0.5 text-xs shadow-sm"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(s.id)}
                      className="h-3 w-3"
                    />
                    {renaming === s.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => submitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename(s.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="w-24 border-b border-gray-300 outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setRenaming(s.id);
                          setRenameValue(s.name);
                        }}
                        className="font-medium text-gray-800"
                      >
                        {s.name}
                      </button>
                    )}
                    <span className="text-gray-400">#{s.order}</span>
                    <button
                      onClick={() => handleDiscard(s.id)}
                      className="text-red-500 hover:text-red-700"
                      title="Scarta questa sezione"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
        </div>

        <div className="w-56 shrink-0 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Sezioni ({sections.length})</p>
          {sections.map((s) => (
            <Link
              key={s.id}
              href={`/admin/sites/${id}/sections/${s.id}`}
              className="flex items-center gap-2 rounded-md border border-gray-100 p-2 text-xs hover:bg-gray-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.sourceScreenshot} alt={s.name} className="h-8 w-14 rounded object-cover object-top" />
              <span className="truncate">{s.name}</span>
            </Link>
          ))}
          {sections.length === 0 && (
            <p className="text-xs text-gray-400">Nessuna sezione ancora rivista — tutte già in annotazione o generate.</p>
          )}
        </div>
      </div>
    </div>
  );
}
