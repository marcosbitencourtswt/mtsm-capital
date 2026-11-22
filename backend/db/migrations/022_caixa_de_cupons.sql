-- Caixa de cupons: cada pessoa envia a foto do comprovante pelo app; depois o Marcos pede ao Claude para ler tudo.
-- SEM gatilho de auditoria (a imagem iria inteira para o registro). Fotos lidas são apagadas em 7 dias (limpeza diária).
CREATE TABLE receipt_inbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code TEXT NOT NULL REFERENCES entity(code),
  uploaded_by UUID NOT NULL REFERENCES app_user(id),
  person_id   UUID REFERENCES person(id),         -- de quem é o gasto
  account_id  UUID REFERENCES account(id),        -- como pagou (conta ou cartão), se a pessoa informou
  note        TEXT,
  image       BYTEA NOT NULL,
  byte_size   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READ', 'DISCARDED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX receipt_inbox_pending_idx ON receipt_inbox (entity_code, created_at) WHERE status = 'PENDING';

-- Chave limitada para o leitor (o Claude numa conversa): só enxerga a caixa de cupons. Guardada só como hash.
CREATE TABLE worker_token (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
