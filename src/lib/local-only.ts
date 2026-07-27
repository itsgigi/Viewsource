/**
 * Il meccanismo di ricostruzione per-sezione (cattura, render, diff, loop)
 * gira SOLO in locale/admin: Playwright e il dev server Vite del mini-renderer
 * non sono disponibili su Vercel serverless. Stessa convenzione di
 * `CAN_CAPTURE` in `src/lib/ingest/index.ts`.
 */
export const CAN_RUN_LOCAL_PIPELINE = !process.env.VERCEL;

export function assertLocalOnly(action: string): void {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    throw new Error(`${action} richiede l'ambiente locale ("npm run dev"): non è disponibile su Vercel.`);
  }
}
