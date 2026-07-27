import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { qdrant, COLLECTION } from "@/lib/qdrant";

// Real RAG chat (Qdrant retrieval + generation): reachable admin-only.
// The public chat is a fake door (see /api/sites/[slug]/chat).

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
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { question, history } = parsed.data;

  // 1. Embed the question
  const vector = await embeddings.embedQuery(question);

  // 2. Retrieval from Qdrant, filtered by site
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

  // 3. Generate the answer
  const response = await chatModel.invoke([
    {
      role: "system",
      content: `You are the assistant for the project "${site.name}" (${site.sourceUrl}).
Answer questions based EXCLUSIVELY on the provided context, extracted from the project's contents.
If the context doesn't contain the answer, say so clearly instead of making it up.
When citing information, indicate the source with the path in parentheses.
Answer in the language of the question.

CONTEXT:
${context}`,
    },
    ...history.slice(-8), // last few turns so the prompt doesn't balloon
    { role: "user", content: question },
  ]);

  // 4. Deduplicated sources for the UI footer
  const sources = [...new Set(chunks.map((c) => c.path))];

  return NextResponse.json({
    answer: response.content,
    sources,
  });
}
