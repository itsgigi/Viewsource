"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface Iteration {
  code: string;
  diffScore: number;
  feedback: string | null;
  renderScreenshot: string;
  diffScreenshot: string;
  createdAt: string;
}

type MediaType = "image" | "video" | "canvas-webgl" | "none";
type Difficulty = "easy" | "medium" | "not-feasible";
type AnimationTag =
  | "reveal-on-scroll"
  | "parallax"
  | "content-swap"
  | "pin-sticky"
  | "hover-effect"
  | "custom-cursor"
  | "none";

interface Annotations {
  mediaType: MediaType;
  animations: AnimationTag[];
  difficulty: Difficulty;
  notes?: string;
}

interface FilmstripFrame {
  url: string;
  scrollY: number;
}

interface SectionDetail {
  id: string;
  siteId: string;
  order: number;
  name: string;
  sourceHtml: string;
  sourceCss: string | null;
  sourceScreenshot: string;
  generatedCode: string | null;
  renderScreenshot: string | null;
  diffScore: number | null;
  status: "captured" | "pending" | "generated" | "approved" | "rejected";
  iterations: Iteration[];
  motionDescription: string | null;
  annotations: Annotations | null;
  detectedLibs: string[] | null;
  filmstrip: FilmstripFrame[] | null;
}

type CompareView = "render" | "diff";

const ANIMATION_OPTIONS: { value: AnimationTag; label: string }[] = [
  { value: "reveal-on-scroll", label: "Reveal on scroll" },
  { value: "parallax", label: "Parallax" },
  { value: "content-swap", label: "Content swap" },
  { value: "pin-sticky", label: "Pin / sticky" },
  { value: "hover-effect", label: "Hover effect" },
  { value: "custom-cursor", label: "Custom cursor" },
  { value: "none", label: "None" },
];

export default function SectionDetailPage() {
  const { id, sectionId } = useParams<{ id: string; sectionId: string }>();
  const [section, setSection] = useState<SectionDetail | null>(null);
  const [view, setView] = useState<CompareView>("render");
  const [feedback, setFeedback] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // HITL annotation (Phase 5b/5c) — initialized from saved values as soon
  // as the section loads, then freely edited before "Mark ready".
  const [mediaType, setMediaType] = useState<MediaType>("none");
  const [animations, setAnimations] = useState<AnimationTag[]>([]);
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [notes, setNotes] = useState("");
  const [motionDescription, setMotionDescription] = useState("");
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sections/${sectionId}`);
    if (!res.ok) return;
    const body: SectionDetail = await res.json();
    setSection(body);
    if (body.annotations) {
      setMediaType(body.annotations.mediaType);
      setAnimations(body.annotations.animations);
      setDifficulty(body.annotations.difficulty);
      setNotes(body.annotations.notes ?? "");
    }
    setMotionDescription(body.motionDescription ?? "");
  }, [sectionId]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleAnimation(tag: AnimationTag) {
    setAnimations((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function saveAnnotationAndMarkReady() {
    setSavingAnnotation(true);
    setError(null);
    try {
      const annotations: Annotations = { mediaType, animations, difficulty, notes: notes.trim() || undefined };
      const res1 = await fetch(`/api/admin/sections/${sectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations }),
      });
      if (!res1.ok) {
        setError((await res1.json().catch(() => null))?.error ?? "Failed to save annotation");
        return;
      }
      const res2 = await fetch(`/api/admin/sections/${sectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motionDescription }),
      });
      if (!res2.ok) {
        setError((await res2.json().catch(() => null))?.error ?? "Failed to save description");
        return;
      }
      const res3 = await fetch(`/api/admin/sections/${sectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      if (res3.ok) setSection(await res3.json());
    } finally {
      setSavingAnnotation(false);
    }
  }

  async function regenerate() {
    if (!feedback.trim()) return;
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sections/${sectionId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Regeneration failed");
      } else {
        setSection(body);
        setFeedback("");
      }
    } catch {
      setError("Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }

  async function setStatus(status: "approved" | "rejected") {
    const res = await fetch(`/api/admin/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) setSection(await res.json());
  }

  async function restore(index: number) {
    const res = await fetch(`/api/admin/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restoreIterationIndex: index }),
    });
    if (res.ok) setSection(await res.json());
  }

  if (!section) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }

  const lastDiffScreenshot = section.iterations[section.iterations.length - 1]?.diffScreenshot ?? null;
  const compareImage = view === "diff" ? lastDiffScreenshot : section.renderScreenshot;

  return (
    <div className="mx-auto max-w-6xl p-8">
      <Link href={`/admin/sites/${id}`} className="text-sm text-gray-500 hover:text-gray-800">
        ← Back to sections
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {section.name} <span className="text-sm font-normal text-gray-400">#{section.order}</span>
          </h1>
          <p className="text-sm text-gray-500">
            Status: {section.status} · diffScore:{" "}
            {section.diffScore === null ? "—" : `${(section.diffScore * 100).toFixed(1)}%`}
          </p>
        </div>
        {section.status !== "captured" && (
          <div className="flex gap-2">
            <button
              onClick={() => setStatus("rejected")}
              className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Reject
            </button>
            <button
              onClick={() => setStatus("approved")}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Approve
            </button>
          </div>
        )}
      </div>

      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {section.status === "captured" && (
        <div className="mt-6 rounded-lg border border-violet-200 bg-violet-50/40 p-4">
          <p className="mb-3 text-sm font-medium text-violet-900">
            HITL review — required before this section can be generated
          </p>

          {section.filmstrip && section.filmstrip.length > 0 && (
            <div className="mb-4">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
                Scroll filmstrip ({section.filmstrip.length} frames)
              </p>
              <div className="flex gap-2 overflow-x-auto">
                {section.filmstrip.map((f, i) => (
                  <img
                    key={i}
                    src={f.url}
                    alt={`Frame ${i}`}
                    className="h-16 w-28 shrink-0 rounded border border-gray-200 object-cover"
                  />
                ))}
              </div>
              {section.detectedLibs && section.detectedLibs.length > 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  Detected libraries: {section.detectedLibs.join(", ")}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600">Media type</label>
                <select
                  value={mediaType}
                  onChange={(e) => setMediaType(e.target.value as MediaType)}
                  className="mt-1 block w-full rounded-md border border-gray-200 p-1.5 text-sm"
                >
                  <option value="none">None</option>
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                  <option value="canvas-webgl">Canvas / WebGL</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Animations present</label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ANIMATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleAnimation(opt.value)}
                      className={`rounded-full px-2 py-1 text-xs ${
                        animations.includes(opt.value) ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Perceived difficulty</label>
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                  className="mt-1 block w-full rounded-md border border-gray-200 p-1.5 text-sm"
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="not-feasible">Not faithfully reconstructible</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Only for quirks the fields above don't cover"
                  className="mt-1 w-full rounded-md border border-gray-200 p-1.5 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600">
                Behavior description (auto-generated — edit where needed)
              </label>
              <textarea
                value={motionDescription}
                onChange={(e) => setMotionDescription(e.target.value)}
                rows={9}
                className="mt-1 w-full rounded-md border border-gray-200 p-1.5 text-sm"
              />
            </div>
          </div>

          <button
            onClick={saveAnnotationAndMarkReady}
            disabled={savingAnnotation}
            className="mt-4 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {savingAnnotation ? "Saving…" : "Save and mark ready for generation"}
          </button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Original</p>
          <img src={section.sourceScreenshot} alt="Original" className="w-full rounded-lg border border-gray-100" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
              {view === "diff" ? "Diff" : "Reconstructed"}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setView("render")}
                className={`rounded-full px-2 py-0.5 text-xs ${
                  view === "render" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                Render
              </button>
              <button
                onClick={() => setView("diff")}
                disabled={!lastDiffScreenshot}
                className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-40 ${
                  view === "diff" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                Diff
              </button>
            </div>
          </div>
          {compareImage ? (
            <img src={compareImage} alt="Reconstructed" className="w-full rounded-lg border border-gray-100" />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-400">
              No reconstruction yet
            </div>
          )}
        </div>
      </div>

      {section.generatedCode && (
        <div className="mt-6">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Generated code</p>
          <pre className="max-h-96 overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-gray-100">
            <code>{section.generatedCode}</code>
          </pre>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-gray-100 p-4">
        <p className="mb-2 text-sm font-medium text-gray-900">Regenerate with feedback</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={3}
          placeholder='E.g. "the title is too small, the background should be black"'
          className="w-full rounded-md border border-gray-200 p-2 text-sm"
        />
        <button
          onClick={regenerate}
          disabled={regenerating || !feedback.trim()}
          className="mt-2 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {regenerating ? "Regenerating…" : "Regenerate this section"}
        </button>
      </div>

      {section.iterations.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium text-gray-900">Attempt history</p>
          <div className="divide-y divide-gray-100 rounded-lg border border-gray-100">
            {section.iterations.map((it, i) => (
              <div key={i} className="flex items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-3">
                  <img src={it.renderScreenshot} alt="" className="h-10 w-16 rounded object-cover" />
                  <div>
                    <p className="text-sm text-gray-900">
                      Attempt #{i + 1} · {(it.diffScore * 100).toFixed(1)}%
                    </p>
                    <p className="text-xs text-gray-400">{it.feedback ?? "automatic loop"}</p>
                  </div>
                </div>
                <button
                  onClick={() => restore(i)}
                  className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
