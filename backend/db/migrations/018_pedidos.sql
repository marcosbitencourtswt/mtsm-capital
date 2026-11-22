-- Pedidos de compra: alguém da casa pede autorização (o quê, quanto, de qual conta/cartão sugere);
-- um responsável que não seja quem pediu aprova (podendo trocar a conta) ou recusa com um recado.
-- Aprovado vira gasto lançado na conta escolhida, em nome de quem vai usar.
CREATE TABLE purchase_request (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code     TEXT NOT NULL REFERENCES entity(code),
  requested_by    UUID NOT NULL REFERENCES app_user(id),
  for_person_id   UUID REFERENCES person(id),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  category        TEXT NOT NULL DEFAULT 'OUTROS',
  account_id      UUID REFERENCES account(id),          -- de onde a pessoa sugeriu sair o dinheiro
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELED')),
  reviewed_by     UUID REFERENCES app_user(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  paid_account_id UUID REFERENCES account(id),          -- de onde saiu de fato (o responsável pode trocar)
  title_id        UUID REFERENCES title(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchase_request_pending_idx ON purchase_request (entity_code, created_at) WHERE status = 'PENDING';
CREATE TRIGGER purchase_request_audit BEFORE INSERT OR UPDATE OR DELETE ON purchase_request FOR EACH ROW EXECUTE FUNCTION audit_trigger();
