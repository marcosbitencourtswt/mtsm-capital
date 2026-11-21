-- NOFINANCE: schema inicial.
-- Dinheiro em centavos (BIGINT). Taxa em pontos-base (1500 = 15%). Ver docs/ADR.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE entity (
  code TEXT PRIMARY KEY CHECK (code IN ('PERSONAL','BYTE4TECH')),
  name TEXT NOT NULL
);
INSERT INTO entity VALUES ('PERSONAL','Pessoal'), ('BYTE4TECH','Byte4Tech (PJ)');

CREATE TYPE title_kind     AS ENUM ('PAYABLE','RECEIVABLE');
-- PAYABLE: EXPENSE (conta/despesa), DEBT (empréstimo), CARD (fatura)
-- RECEIVABLE: INCOME (receita), LOAN_IN (empréstimo recebido: NÃO é receita)
CREATE TYPE title_nature   AS ENUM ('EXPENSE','DEBT','CARD','INCOME','LOAN_IN');
CREATE TYPE interest_model AS ENUM ('NONE','FIXED_ONCE','MONTHLY_SIMPLE','MONTHLY_COMPOUND');
CREATE TYPE pay_method     AS ENUM ('ACCOUNT','CARD');

-- Lançamentos automáticos mensais (aluguel, água, luz, internet...)
CREATE TABLE recurrence (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code          TEXT NOT NULL REFERENCES entity(code),
  kind                 title_kind   NOT NULL,
  nature               title_nature NOT NULL,
  description          TEXT NOT NULL CHECK (length(trim(description)) > 0),
  category             TEXT NOT NULL,
  default_amount_cents BIGINT CHECK (default_amount_cents >= 0),  -- NULL: valor varia; usa o do mês anterior
  due_day              SMALLINT CHECK (due_day BETWEEN 1 AND 31),
  start_month          DATE NOT NULL CHECK (extract(day FROM start_month) = 1),
  end_month            DATE CHECK (end_month IS NULL OR end_month >= start_month),
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (nature IN ('EXPENSE','INCOME'))
);

-- Conta a pagar / a receber (previsto)
CREATE TABLE title (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code      TEXT NOT NULL REFERENCES entity(code),
  kind             title_kind   NOT NULL,
  nature           title_nature NOT NULL,
  counterparty     TEXT NOT NULL CHECK (length(trim(counterparty)) > 0),
  category         TEXT NOT NULL DEFAULT 'GERAL',
  amount_cents     BIGINT NOT NULL CHECK (amount_cents >= 0),   -- 0 = valor a definir
  interest_model   interest_model NOT NULL DEFAULT 'NONE',
  rate_bp          INTEGER NOT NULL DEFAULT 0 CHECK (rate_bp >= 0),
  due_date         DATE,
  start_date       DATE NOT NULL DEFAULT current_date,
  competence_month DATE CHECK (competence_month IS NULL OR extract(day FROM competence_month) = 1),
  recurrence_id    UUID REFERENCES recurrence(id),
  linked_title_id  UUID REFERENCES title(id),
  notes            TEXT,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'PAYABLE'    AND nature IN ('EXPENSE','DEBT','CARD'))
      OR (kind = 'RECEIVABLE' AND nature IN ('INCOME','LOAN_IN'))),
  CHECK (nature = 'DEBT' OR (interest_model = 'NONE' AND rate_bp = 0)),
  CHECK ((interest_model = 'NONE') = (rate_bp = 0))
);
-- Idempotência da geração automática: uma conta por recorrência por mês.
-- Inclui excluídas: se você apagar a conta de um mês, o gerador não a recria.
ALTER TABLE title ADD CONSTRAINT title_recurrence_month_uq UNIQUE (recurrence_id, competence_month);
CREATE INDEX title_entity_due_idx ON title (entity_code, due_date) WHERE deleted_at IS NULL;
CREATE INDEX title_entity_kind_idx ON title (entity_code, kind, nature) WHERE deleted_at IS NULL;

-- Baixa: pagamento ou recebimento (realizado)
CREATE TABLE settlement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id        UUID NOT NULL REFERENCES title(id),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  paid_on         DATE NOT NULL,
  method          pay_method NOT NULL DEFAULT 'ACCOUNT',
  notes           TEXT,
  idempotency_key TEXT UNIQUE,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlement_title_idx ON settlement (title_id) WHERE deleted_at IS NULL;
CREATE INDEX settlement_paid_on_idx ON settlement (paid_on) WHERE deleted_at IS NULL;

-- Parâmetros do guardião por entidade
CREATE TABLE setting (
  entity_code TEXT NOT NULL REFERENCES entity(code),
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_code, key)
);

-- Auditoria: toda alteração guarda antes/depois. Edição é livre; o histórico não se perde.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  action     TEXT NOT NULL,
  old_data   JSONB,
  new_data   JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_row_idx ON audit_log (table_name, row_id);

CREATE FUNCTION audit_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data)
  VALUES (TG_TABLE_NAME,
          COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id', to_jsonb(NEW)->>'key', to_jsonb(OLD)->>'key'),
          TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER title_audit      BEFORE INSERT OR UPDATE OR DELETE ON title      FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER settlement_audit BEFORE INSERT OR UPDATE OR DELETE ON settlement FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER recurrence_audit BEFORE INSERT OR UPDATE OR DELETE ON recurrence FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER setting_audit    BEFORE INSERT OR UPDATE OR DELETE ON setting    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- Exclusão física proibida: só lógica (deleted_at), para preservar histórico.
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Exclusão física proibida em %; use deleted_at', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER title_nodelete      BEFORE DELETE ON title      FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER settlement_nodelete BEFORE DELETE ON settlement FOR EACH ROW EXECUTE FUNCTION forbid_delete();
