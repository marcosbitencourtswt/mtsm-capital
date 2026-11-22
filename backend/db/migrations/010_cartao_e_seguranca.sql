-- Compra no cartão ligada à fatura (evita contar a despesa duas vezes) e tentativas de login por endereço de rede.
ALTER TABLE title ADD COLUMN card_bill_id UUID REFERENCES title(id);
CREATE INDEX title_card_bill_idx ON title (card_bill_id) WHERE deleted_at IS NULL;

CREATE TABLE login_attempt (
  ip  TEXT NOT NULL,
  at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok  BOOLEAN NOT NULL
);
CREATE INDEX login_attempt_ip_idx ON login_attempt (ip, at);
