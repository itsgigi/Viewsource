import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Studio di ricostruzione assistita: file generati/editati a mano fuori
    // dal progetto Next (mai importati dall'app, niente motivo per farli
    // rispettare le regole lint dell'app — vedi tsconfig.json "exclude").
    "reconstructions/**",
    // Working copy delle repo clonate per l'ingestion "git" (src/lib/ingest/git.ts):
    // codice di un progetto altrui, non del nostro — stessa ragione di reconstructions/.
    "repos/**",
  ]),
]);

export default eslintConfig;
