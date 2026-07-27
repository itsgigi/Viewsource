/**
 * The per-section reconstruction mechanism (capture, render, diff, loop)
 * runs LOCAL/ADMIN ONLY: Playwright and the mini-renderer's Vite dev
 * server aren't available on Vercel serverless. Same convention as
 * `CAN_CAPTURE` in `src/lib/ingest/index.ts`.
 */
export const CAN_RUN_LOCAL_PIPELINE = !process.env.VERCEL;

export function assertLocalOnly(action: string): void {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    throw new Error(`${action} requires the local environment ("npm run dev"): it isn't available on Vercel.`);
  }
}
