import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { qdrant, COLLECTION } from "@/lib/qdrant";

// Chat RAG vera (retrieval Qdrant + generazione): raggiungibile solo
// dall'admin. La chat pubblica è un fake door (vedi /api/sites/[slug]/chat).

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
});

const bodySchema = z.object({
  question: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .default([]),
});

interface ChunkPayload {
  path: string;
  kind: string;
  chunkIndex: number;
  text: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { question, history } = parsed.data;

  // 1. Embedda la domanda
  const vector = await embeddings.embedQuery(question);

  // 2. Retrieval da Qdrant, filtrato sul sito
  const hits = await qdrant.search(COLLECTION, {
    vector,
    limit: 8,
    filter: {
      must: [{ key: "siteId", match: { value: id } }],
    },
    with_payload: true,
  });

  const chunks = hits
    .map((h) => h.payload as unknown as ChunkPayload)
    .filter(Boolean);

  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.path}\n${c.text}`)
    .join("\n\n---\n\n");

  // 3. Genera la risposta
  const response = await chatModel.invoke([
    {
      role: "system",
      content: `Sei l'assistente del progetto "${site.name}" (${site.sourceUrl}).
Rispondi alle domande basandoti ESCLUSIVAMENTE sul contesto fornito, estratto dai contenuti del progetto.
Se il contesto non contiene la risposta, dillo chiaramente invece di inventare.
Quando citi informazioni, indica la fonte con il path tra parentesi.
Rispondi nella lingua della domanda.

CONTESTO:
${context}`,
    },
    ...history.slice(-8), // ultimi turni per non gonfiare il prompt
    { role: "user", content: question },
  ]);

  // 4. Fonti deduplicate per il footer della UI
  const sources = [...new Set(chunks.map((c) => c.path))];

  return NextResponse.json({
    answer: response.content,
    sources,
  });
}
