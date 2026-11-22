-- Extrato importado (OFX): cada movimentação do banco, uma vez só por conta (FITID).
-- Guarda o que foi feito com ela e a categoria escolhida, para sugerir igual da próxima vez.
CREATE TABLE bank_txn (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES account(id),
  fitid       TEXT NOT NULL,
  posted_on   DATE NOT NULL,
  amount_cents BIGINT NOT NULL,
  memo        TEXT NOT NULL,
  memo_key    TEXT,
  action      TEXT NOT NULL CHECK (action IN ('despesa','receita','transferencia','ignorar')),
  category    TEXT,
  person_id   UUID REFERENCES person(id),
  title_id    UUID REFERENCES title(id),
  transfer_id UUID REFERENCES transfer(id),
  created_by  UUID REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, fitid)
);
CREATE INDEX bank_txn_memo_idx ON bank_txn (memo_key, created_at DESC);
CREATE TRIGGER bank_txn_audit BEFORE INSERT OR UPDATE OR DELETE ON bank_txn FOR EACH ROW EXECUTE FUNCTION audit_trigger();
