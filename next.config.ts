import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Il mini-renderer (src/lib/render) gira solo in locale/admin e usa un dev
  // server Vite vero (per Tailwind JIT identico al progetto): questi pacchetti
  // vanno risolti con require() nativo a runtime, non bundlati — altrimenti
  // webpack prova a tracciare i loro import() dinamici interni (esbuild,
  // lightningcss, .node bindings) e fallisce. "playwright"/"sharp" sono già
  // esclusi di default da Next; qui aggiungiamo il resto della stessa filiera.
  serverExternalPackages: ["vite", "@tailwindcss/vite", "@vitejs/plugin-react", "pixelmatch", "pngjs"],
};

export default nextConfig;
