import { QdrantClient } from "@qdrant/js-client-rest";

export const COLLECTION = "site_chunks";

// text-embedding-3-small → 1536 dim. Se cambi modello, aggiorna qui.
const VECTOR_SIZE = 1536;

const globalForQdrant = globalThis as unknown as { qdrant?: QdrantClient };

export const qdrant =
  globalForQdrant.qdrant ??
  new QdrantClient({
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
    // Opzionale: richiesta solo da Qdrant Cloud; in locale resta undefined
    apiKey: process.env.QDRANT_API_KEY,
  });

if (process.env.NODE_ENV !== "production") globalForQdrant.qdrant = qdrant;

/**
 * Crea la collection se non esiste. Chiamala all'avvio della pipeline
 * di ingestion (idempotente).
 *
 * Payload di ogni point:
 * { siteId, documentId, path, kind, chunkIndex, text }
 * L'indice su siteId permette il filtro per sito nelle query RAG.
 */
export async function ensureCollection() {
  const { collections } = await qdrant.getCollections();

  if (!collections.some((c) => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }

  await qdrant
    .createPayloadIndex(COLLECTION, {
      field_name: "siteId",
      field_schema: "keyword",
    })
    .catch(() => null); // già esistente
}
