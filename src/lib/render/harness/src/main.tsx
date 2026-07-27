import { createRoot } from "react-dom/client";
import Component from "./Component";

// Component.tsx viene sovrascritto ad ogni render da src/lib/render/index.ts,
// che invalida esplicitamente il modulo (e quello di index.css) nel module
// graph di Vite prima di navigare: un import statico va bene perché non
// dipendiamo dal timing del watcher per capire che il file è cambiato.
async function main() {
  const root = createRoot(document.getElementById("render-root")!);
  root.render(<Component />);

  await document.fonts.ready;
  // Piccolo margine per far assestare font/immagini dopo il mount.
  await new Promise((resolve) => setTimeout(resolve, 150));
  (window as unknown as { __RENDER_READY__?: boolean }).__RENDER_READY__ = true;
}

main();
