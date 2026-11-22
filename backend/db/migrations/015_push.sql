-- Avisos no celular (Web Push, padrão aberto dos navegadores; sem custo e sem terceiros).
-- Chaves VAPID geradas pelo próprio sistema na 1ª vez. Tabela SEM gatilho de auditoria: a chave privada não vai para o registro.
CREATE TABLE push_key (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Cada aparelho que aceitou receber avisos.
CREATE TABLE push_subscription (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES app_user(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ,
  fail_count  SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX push_subscription_user_idx ON push_subscription (user_id);
