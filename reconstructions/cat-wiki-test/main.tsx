import { createRoot } from "react-dom/client";
import Page from "./page";

const sectionModules = import.meta.glob("./sections/*.tsx");

async function main() {
  const root = createRoot(document.getElementById("render-root")!);
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");

  if (section) {
    const loader = sectionModules[`./sections/${section}`];
    if (!loader) throw new Error(`Sezione non trovata nello studio: ${section}`);
    const mod = (await loader()) as { default: React.ComponentType };
    root.render(<mod.default />);
  } else {
    root.render(<Page />);
  }

  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 150));
  (window as unknown as { __RENDER_READY__?: boolean }).__RENDER_READY__ = true;
}

main();
