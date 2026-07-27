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
    .describe("Un nome breve e sensato per ciascuna sezione, nello stesso ordine di input"),
});

/**
 * Etichetta ogni sezione catturata con un nome sensato ("Hero", "Features",
 * "Footer"...) in un'unica chiamata batch — economico, non serve un modello
 * vision-capable per questo passo (etichettatura da solo HTML, non screenshot).
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
        'Assegna un nome breve e leggibile (es. "Hero", "Features", "Pricing", "Footer", "Navbar") a ciascuna sezione HTML di una pagina web, nell\'ordine in cui è fornita. Restituisci esattamente un nome per sezione, nello stesso ordine.',
    },
    { role: "user", content: listing },
  ]);

  // Difesa minima: se il modello restituisse un numero diverso di nomi,
  // riallinea al numero di sezioni realmente catturate.
  return sections.map((_, i) => result.names[i] ?? `Section ${i + 1}`);
}
