-- Verificação em duas etapas (TOTP, app autenticador). Opcional por usuário.
ALTER TABLE app_user ADD COLUMN totp_secret TEXT;            -- base32; NULL = desativado
ALTER TABLE app_user ADD COLUMN totp_pending TEXT;           -- segredo gerado, aguardando o 1º código
ALTER TABLE app_user ADD COLUMN totp_last_step BIGINT;       -- impede reutilizar o mesmo código
ALTER TABLE app_user ADD COLUMN totp_enabled_at TIMESTAMPTZ;

CREATE TABLE recovery_code (
  user_id    UUID NOT NULL REFERENCES app_user(id),
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- Login em duas etapas: senha certa gera um desafio curto; o código fecha o login.
CREATE TABLE mfa_challenge (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES app_user(id),
  user_agent TEXT,
  attempts   SMALLINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

-- O registro de alterações nunca guarda senha nem segredo do autenticador.
CREATE OR REPLACE FUNCTION audit_user_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data)
  VALUES ('app_user', COALESCE(NEW.id, OLD.id)::text, TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' - 'totp_secret' - 'totp_pending' END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' - 'totp_secret' - 'totp_pending' END);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
