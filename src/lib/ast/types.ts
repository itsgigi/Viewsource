export interface PropField {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
}

export interface ImportRef {
  source: string; // come scritto nel file, es. "./useParallax", "framer-motion", "@/lib/utils"
  isLocal: boolean; // relativo o alias risolto a un file del repo
}

// Componente React esportato individuato in un singolo file (Fase 2, prima
// della risoluzione del bundle multi-file — vedi dependencyGraph.ts).
export interface ParsedComponent {
  name: string;
  filePath: string; // relativo alla root del repo
  isDefaultExport: boolean;
  props: PropField[];
  imports: ImportRef[];
  hooks: string[];
  styleFiles: string[]; // import di file di stile (relativi)
  tailwindClasses: string[];
}

export interface BundleFile {
  path: string;
  content: string;
}

// Componente pronto per la persistenza come riga Component (origin "ast").
export interface AstComponent extends ParsedComponent {
  bundleFiles: BundleFile[];
  npmDeps: string[];
}

export type Framework =
  | "next-app"
  | "next-pages"
  | "vite"
  | "remix"
  | "astro"
  | "unknown";

export interface DesignTokens {
  palette: string[];
  fonts: string[];
  notes: string;
}
