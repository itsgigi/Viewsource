# Spec di rework — Fase 1 + 2: da tool personale a servizio pubblico

## Contesto

Questo repo (`site-ingestion`) è un tool Next.js (App Router, TypeScript, Tailwind, Prisma 7 con SQLite, Qdrant, LangChain + OpenAI) che fa ingestion di siti web (Firecrawl) e repo Git (simple-git), li analizza con AI (descrizione, tech stack, design info, componenti) e permette di estrarre componenti come codice o come prompt per LLM.

**IMPORTANTE: esplora il codice esistente prima di modificare qualsiasi cosa.** Il proprietario ha fatto modifiche autonome: adattati a ciò che trovi, non assumere che i file corrispondano a una versione precedente. Non riscrivere ciò che funziona; fai refactoring mirati.

## Obiettivo del rework

Il progetto diventa un servizio pubblico: una galleria curata di siti selezionati (stile Awwwards) da cui i visitatori possono estrarre componenti come codice o prompt. L'ingestion e la cura editoriale restano private (solo admin). Nessuna registrazione utenti in questa fase.

## Fase 1 — Modello dati

1. **Rinomina il modello `Project` in `Site`** (migration Prisma inclusa, aggiorna tutti i riferimenti nel codice). Aggiungi i campi:
   - `slug String @unique` — generato dal nome alla creazione (kebab-case, dedupe con suffisso numerico)
   - `status String @default("draft")` — valori: `draft | published` (sostituisce/affianca lo status di pipeline esistente: ATTENZIONE, lo status di pipeline `pending|ingesting|analyzing|ready|failed` deve continuare a esistere; usa due campi separati, es. `pipelineStatus` e `visibility`, scegli nomi coerenti con il codice attuale)
   - `featured Boolean @default(false)`
   - `screenshots String?` — JSON array di URL (per fonti future)

2. **Nuova tabella `Source`** per il multi-fonte:
   ```prisma
   model Source {
     id        String   @id @default(cuid())
     siteId    String
     site      Site     @relation(fields: [siteId], references: [id], onDelete: Cascade)
     type      String   // "awwwards" | "manual" | "crawl" | "git" | ...
     url       String
     data      String?  // JSON: dati estratti dalla fonte (tags, award, credits...)
     fetchedAt DateTime @default(now())
     @@index([siteId])
   }
   ```
   Non implementare ancora connettori: serve solo la struttura. NON salvare scores/voti delle fonti (decisione di prodotto: non interessano e riducono i rischi ToS).

3. **Campo `origin` su `Component`**: `String @default("ai")` — valori `ai | source` (per distinguere componenti dedotti dall'analisi da highlight importati da fonti esterne in futuro).

4. **Nuova tabella `ChatIntent`** per il fake door test della chat:
   ```prisma
   model ChatIntent {
     id        String   @id @default(cuid())
     siteId    String
     question  String
     createdAt DateTime @default(now())
     @@index([siteId])
   }
   ```

## Fase 2 — Separazione pubblico/privato

### Route groups

Riorganizza `src/app` in due route group:

- **`(public)`** — accessibile a tutti:
  - `/` — galleria: SOLO siti con visibilità `published`, card con nome, screenshot/placeholder, tech stack. Niente form di ingestion, niente pulsanti di stato pipeline, niente elimina.
  - `/sites/[slug]` — dettaglio sito: analisi, tech stack, design info, tab Componenti / Documenti / Chat. URL per slug, non per id.
- **`(admin)`** — protetto:
  - `/admin` — l'attuale home con form ingestion, lista completa (draft + published), stati pipeline, elimina, e un toggle publish/unpublish per sito.
  - `/admin/login` — form con solo campo password.

### Auth admin (niente provider esterni, niente registrazione)

- Password in env: `ADMIN_PASSWORD`. Secret per firma: `AUTH_SECRET`.
- POST di login verifica la password e setta un cookie httpOnly `admin_session` con JWT firmato via libreria `jose` (scadenza 7 giorni, `secure` in production, `sameSite: lax`).
- `middleware.ts` protegge:
  - tutte le pagine `/admin/*` (tranne `/admin/login`) → redirect a login se cookie assente/invalido
  - tutte le API mutanti: creazione siti, delete, re-ingestion, publish/unpublish → 401 se cookie assente/invalido
- **Eccezioni esplicite (devono restare pubbliche):**
  - GET di lettura (lista published, dettaglio sito)
  - POST estrazione componente (i visitatori generano la prima estrazione)
  - POST chat (fake door, vedi sotto)

### Estrazione componenti — semplificazione

- Due sole modalità: **codice** (target fisso: React + TypeScript + Tailwind CSS) e **prompt LLM**. Rimuovi il selettore dello stack target dalla UI e il parametro `target` dall'API (o ignoralo forzando il default).
- Generazione lazy con cache permanente: alla prima richiesta genera e salva su `Component.code` / `Component.prompt`; dalle successive restituisci SOLO il salvato, senza chiamare OpenAI. Se il codice attuale ha un pulsante "Rigenera", deve sparire dalla UI pubblica (può restare in admin).
- L'endpoint pubblico di estrazione, se il componente ha già il campo popolato, NON deve mai chiamare OpenAI.

### Chat — fake door test

- La tab Chat resta visibile nella pagina pubblica del sito, con la stessa UI.
- Quando l'utente invia un messaggio, l'endpoint pubblico: salva `{siteId, question}` in `ChatIntent` e risponde con un messaggio fisso tipo: "La chat AI sui progetti è in arrivo — stiamo misurando l'interesse. Nel frattempo puoi esplorare i componenti e l'analisi."
- NON eliminare il codice RAG esistente (retrieval Qdrant + generazione): va mantenuto funzionante e raggiungibile solo dall'admin (la pagina admin del sito può usare la chat vera), oppure lasciato dormiente ma integro se una pagina admin di dettaglio non esiste.
- In `/admin` aggiungi un contatore semplice: numero di ChatIntent totali e per sito (basta una query, niente dashboard).

## Cosa NON fare

- Non toccare la pipeline di ingestion (Firecrawl/git/analyze/embeddings) se non per rinominare i riferimenti Project→Site.
- Non aggiungere sistemi di registrazione, ruoli, o provider OAuth.
- Non pre-generare estrazioni.
- Non implementare connettori alle fonti esterne (solo la tabella Source).
- Non migrare a Postgres in questa fase (resta SQLite; la migrazione avverrà al deploy).

## Criteri di accettazione

1. Visitatore anonimo: vede in home solo i siti published; apre `/sites/[slug]`; estrae codice e prompt di un componente (prima volta genera, seconda volta risposta istantanea dal DB); invia un messaggio in chat e riceve il messaggio "in arrivo"; NON può creare/eliminare siti né vedere `/admin` (redirect a login).
2. Admin loggato: crea un sito, lo vede passare per gli stati di pipeline, lo pubblica col toggle, lo vede comparire nella home pubblica; vede il conteggio dei ChatIntent.
3. `npx prisma migrate dev` gira pulito; `npm run build` passa senza errori TypeScript.
