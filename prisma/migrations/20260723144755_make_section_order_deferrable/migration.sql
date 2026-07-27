-- Il boundary editor HITL (merge/split/discard/resize) ri-numera l'intero
-- ordinamento delle sezioni di un sito dentro una singola transazione.
-- Un semplice UNIQUE INDEX su (siteId, order) viene validato per ogni
-- singola istruzione UPDATE, non a fine transazione: riassegnare più righe
-- (specie in ordine diverso) può quindi violarlo transitoriamente anche
-- dentro un'unica transazione atomica. Convertito in CONSTRAINT UNIQUE
-- DEFERRABLE INITIALLY DEFERRED: la validazione slitta al COMMIT, quindi
-- qualunque sequenza di riassegnazioni intermedie è ammessa.
DROP INDEX "Section_siteId_order_key";

ALTER TABLE "Section" ADD CONSTRAINT "Section_siteId_order_key"
  UNIQUE ("siteId", "order") DEFERRABLE INITIALLY DEFERRED;
