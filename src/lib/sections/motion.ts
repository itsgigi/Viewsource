import { ChatOpenAI } from "@langchain/openai";
import type { Section } from "@/generated/prisma/client";
import type { FilmstripFrame, MotionHint } from "@/lib/ingest/capture";

// Description of scroll-driven behavior: it's not the final product (the
// reconstructed code is), so a cheap model is enough — the admin reviews
// and corrects it anyway before it counts for anything (Phase 5c).
const motionModel = new ChatOpenAI({
  model: process.env.OPENAI_MOTION_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
});

const SYSTEM_PROMPT = `You're looking at a sequence of screenshots (filmstrip) of ONE section of a website, taken by scrolling progressively from top to bottom. Describe in English, in a few sentences, what visually changes from one frame to the next: what enters/exits and in which direction, what gets replaced and at roughly what point in the scroll, what seems to have a parallax effect (moves at a different speed than the scroll), what seems sticky/pinned (stays fixed while the rest scrolls). If the sequence shows no notable changes, say so clearly and briefly ("no obvious animation"). Don't invent behavior you don't see in the frames. Maximum 5-6 sentences.`;

function parseJson<T>(value: string | null | unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Generates the automatic description of a section's scroll-driven
 * behavior from its filmstrip. Never asks the admin to write it from
 * scratch — shows it and lets them correct it where needed (Phase 5c).
 */
export async function generateMotionDescription(section: Section): Promise<string> {
  const filmstrip = parseJson<FilmstripFrame[]>(section.filmstrip, []);
  if (filmstrip.length === 0) {
    return "No scroll frames captured for this section: it was probably not visible during filmstrip capture, or it's too short for the scroll to pass through it noticeably.";
  }

  const motionHints = parseJson<MotionHint[]>(section.motionHints, []);
  const detectedLibs = parseJson<string[]>(section.detectedLibs, []);

  const hintsText =
    motionHints.length > 0
      ? motionHints
          .map(
            (h) =>
              `- between frame ${h.fromFrame} and ${h.toFrame}: changed region (y ${h.pageTop}-${h.pageBottom}px on page), ${(h.changedRatio * 100).toFixed(1)}% pixels different`
          )
          .join("\n")
      : "(no relevant difference mechanically detected between frames)";

  const textParts = [
    `SECTION: "${section.name}"`,
    `Animation libraries detected on the page: ${detectedLibs.length > 0 ? detectedLibs.join(", ") : "none"}`,
    `Regions changed between consecutive frames (computed mechanically, pixelmatch):\n${hintsText}`,
    `Below are ${filmstrip.length} frames in increasing scroll order.`,
  ].join("\n\n");

  const images = filmstrip.map((f) => ({
    type: "image_url" as const,
    image_url: { url: f.url },
  }));

  const result = await motionModel.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text" as const, text: textParts }, ...images] },
  ]);

  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}
