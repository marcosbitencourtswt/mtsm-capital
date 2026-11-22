-- Registro de alterações: quem fez. A aplicação informa o usuário na transação (app.user_id);
-- gravações automáticas (cron, scripts) ficam com actor_id NULL = "sistema".
ALTER TABLE audit_log ADD COLUMN actor_id UUID;
CREATE INDEX audit_at_idx ON audit_log (at);
CREATE INDEX audit_actor_idx ON audit_log (actor_id, at);

CREATE OR REPLACE FUNCTION audit_actor() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data, actor_id)
  VALUES (TG_TABLE_NAME,
          COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id', to_jsonb(NEW)->>'key', to_jsonb(OLD)->>'key',
                   to_jsonb(NEW)->>'person_id', to_jsonb(OLD)->>'person_id', '?'),
          TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          audit_actor());
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_user_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data, actor_id)
  VALUES ('app_user', COALESCE(NEW.id, OLD.id)::text, TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' - 'totp_secret' - 'totp_pending' END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' - 'totp_secret' - 'totp_pending' END,
          audit_actor());
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
