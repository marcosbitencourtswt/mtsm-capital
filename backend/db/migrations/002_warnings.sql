-- Uso pessoal: nada é bloqueado. Regras viram AVISOS gravados no lançamento (e na auditoria).
ALTER TABLE settlement ADD COLUMN warnings TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX settlement_warnings_idx ON settlement ((cardinality(warnings) > 0)) WHERE deleted_at IS NULL;
