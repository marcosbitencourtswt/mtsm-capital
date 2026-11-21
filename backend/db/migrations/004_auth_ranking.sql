-- Login (e-mail + senha), sessões revogáveis e classificação obrigatório/não obrigatório para o ranking.

CREATE TYPE user_role AS ENUM ('ADMIN', 'MEMBER');

CREATE TABLE app_user (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL CHECK (email = lower(trim(email)) AND position('@' IN email) > 1),
  name                 TEXT NOT NULL CHECK (length(trim(name)) > 0),
  nickname             TEXT,                               -- ex.: "Gastadora"
  role                 user_role NOT NULL DEFAULT 'MEMBER',
  person_id            UUID REFERENCES person(id),         -- quem ele é em "Pessoas da casa"
  password_hash        TEXT NOT NULL,                      -- scrypt; nunca sai da API nem vai para a auditoria
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  active               BOOLEAN NOT NULL DEFAULT true,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (email);
CREATE UNIQUE INDEX app_user_person_uq ON app_user (person_id) WHERE person_id IS NOT NULL;

-- Auditoria do usuário SEM o hash da senha.
CREATE FUNCTION audit_user_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data)
  VALUES ('app_user', COALESCE(NEW.id, OLD.id)::text, TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' END);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER app_user_audit BEFORE INSERT OR UPDATE OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION audit_user_trigger();
CREATE TRIGGER app_user_nodelete BEFORE DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Sessão: o cookie leva um token aleatório; o banco guarda só o SHA-256 dele.
CREATE TABLE user_session (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  user_agent   TEXT
);
CREATE INDEX user_session_user_idx ON user_session (user_id);

-- Quem lançou (para "edita só o que lançou") e a classificação do ranking.
ALTER TABLE title      ADD COLUMN created_by UUID REFERENCES app_user(id);
ALTER TABLE settlement ADD COLUMN created_by UUID REFERENCES app_user(id);
ALTER TABLE title      ADD COLUMN mandatory BOOLEAN;  -- NULL = decide pela categoria; true/false = revisado pelo admin
