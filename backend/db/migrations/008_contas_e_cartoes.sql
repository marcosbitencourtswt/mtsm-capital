-- Bancos, cartões, empréstimos e saldos por dono. Cada produto é independente:
-- uma instituição pode ter só saldo, só dívida, conta + cartão etc.

CREATE TABLE institution (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code TEXT NOT NULL REFERENCES entity(code),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX institution_name_uq ON institution (entity_code, lower(name));

-- CHECKING conta/carteira digital · SAVINGS poupança/reserva · INVESTMENT investimento
-- CARD cartão de crédito · LOAN empréstimo/financiamento · CASH dinheiro em espécie
CREATE TYPE account_type AS ENUM ('CHECKING', 'SAVINGS', 'INVESTMENT', 'CARD', 'LOAN', 'CASH');

CREATE TABLE account (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code           TEXT NOT NULL REFERENCES entity(code),
  institution_id        UUID REFERENCES institution(id),
  owner_person_id       UUID REFERENCES person(id),          -- NULL = dos dois / da casa
  type                  account_type NOT NULL,
  name                  TEXT NOT NULL CHECK (length(trim(name)) > 0),
  opening_balance_cents BIGINT NOT NULL DEFAULT 0,           -- saldo informado na carga inicial (contas)
  opening_date          DATE NOT NULL DEFAULT current_date,
  credit_limit_cents    BIGINT CHECK (credit_limit_cents >= 0),
  closing_day           SMALLINT CHECK (closing_day BETWEEN 1 AND 31),
  due_day               SMALLINT CHECK (due_day BETWEEN 1 AND 31),
  monthly_rate_bp       INTEGER CHECK (monthly_rate_bp BETWEEN 0 AND 100000),  -- juros ao mês (rotativo/contrato), se souber
  rate_source           TEXT,                                -- "fatura", "contrato", "pesquisa BC" etc.
  notes                 TEXT,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_owner_idx ON account (entity_code, owner_person_id) WHERE active;
CREATE TRIGGER account_audit BEFORE INSERT OR UPDATE OR DELETE ON account FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER institution_audit BEFORE INSERT OR UPDATE OR DELETE ON institution FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- Conta/fatura/parcela ligada a um produto (ex.: fatura do cartão Nubank, parcela 3/12 do empréstimo).
ALTER TABLE title ADD COLUMN account_id UUID REFERENCES account(id);
ALTER TABLE title ADD COLUMN installment_no INTEGER CHECK (installment_no > 0);
ALTER TABLE title ADD COLUMN installment_total INTEGER CHECK (installment_total > 0);
CREATE INDEX title_account_idx ON title (account_id) WHERE deleted_at IS NULL;
-- De qual conta saiu/entrou o dinheiro de um pagamento/recebimento.
ALTER TABLE settlement ADD COLUMN account_id UUID REFERENCES account(id);
CREATE INDEX settlement_account_idx ON settlement (account_id) WHERE deleted_at IS NULL;

-- Transferência entre contas próprias: não é receita nem despesa.
CREATE TABLE transfer (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id UUID NOT NULL REFERENCES account(id),
  to_account_id   UUID NOT NULL REFERENCES account(id) CHECK (to_account_id <> from_account_id),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  day             DATE NOT NULL DEFAULT current_date,
  note            TEXT,
  created_by      UUID REFERENCES app_user(id),
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER transfer_audit BEFORE INSERT OR UPDATE OR DELETE ON transfer FOR EACH ROW EXECUTE FUNCTION audit_trigger();
