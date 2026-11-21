-- Pessoas da casa: cada conta (e conta automática) pode ser vinculada a uma pessoa.
CREATE TABLE person (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code TEXT NOT NULL REFERENCES entity(code),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  relation    TEXT,                       -- ex.: esposa, filho, mãe
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX person_entity_name_uq ON person (entity_code, lower(name));

CREATE TRIGGER person_audit BEFORE INSERT OR UPDATE OR DELETE ON person FOR EACH ROW EXECUTE FUNCTION audit_trigger();
-- Pessoa não é apagada (o histórico de custos depende dela): só desativada.
CREATE TRIGGER person_nodelete BEFORE DELETE ON person FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE title      ADD COLUMN person_id UUID REFERENCES person(id);
ALTER TABLE recurrence ADD COLUMN person_id UUID REFERENCES person(id);
CREATE INDEX title_person_idx ON title (person_id) WHERE deleted_at IS NULL;
