import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import type { GroundTruthSection } from "@/lib/ingest/capture";

const labelModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

const labelsSchema = z.object({
  names: z
    .array(z.string())
    .describe("A short, sensible name for each section, in the same order as the input"),
});

/**
 * Labels each captured section with a sensible name ("Hero", "Features",
 * "Footer"...) in a single batch call — cheap, no vision-capable model
 * needed for this step (labeling from HTML only, not screenshots).
 */
export async function labelSections(sections: GroundTruthSection[]): Promise<string[]> {
  if (sections.length === 0) return [];

  const structured = labelModel.withStructuredOutput(labelsSchema, { name: "section_labels" });

  const listing = sections
    .map((s, i) => `[${i}] <${s.tag}> selector="${s.selector}"\n${s.html.slice(0, 500)}`)
    .join("\n\n");

  const result = await structured.invoke([
    {
      role: "system",
      content:
        'Assign a short, readable name (e.g. "Hero", "Features", "Pricing", "Footer", "Navbar") to each HTML section of a web page, in the order provided. Return exactly one name per section, in the same order.',
    },
    { role: "user", content: listing },
  ]);

  // Minimal safeguard: if the model returned a different number of names,
  // realign to the actual number of captured sections.
  return sections.map((_, i) => result.names[i] ?? `Section ${i + 1}`);
}
