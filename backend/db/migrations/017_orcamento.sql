-- Orçamento: teto mensal por categoria (só nas que a família quer vigiar).
CREATE TABLE budget (
  entity_code  TEXT NOT NULL REFERENCES entity(code),
  category     TEXT NOT NULL,
  limit_cents  BIGINT NOT NULL CHECK (limit_cents > 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_code, category)
);
CREATE TRIGGER budget_audit BEFORE INSERT OR UPDATE OR DELETE ON budget FOR EACH ROW EXECUTE FUNCTION audit_trigger();
-- Aviso de 80% / 100% sai uma vez por categoria por mês.
CREATE TABLE budget_alert (
  entity_code TEXT NOT NULL, category TEXT NOT NULL, month DATE NOT NULL, level SMALLINT NOT NULL,
  PRIMARY KEY (entity_code, category, month, level)
);
