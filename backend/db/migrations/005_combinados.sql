-- Combinados da família: hábitos diários (cada um marca os seus) e ocorrências (responsáveis registram),
-- com pontos e multa em dinheiro configuráveis. Multas ficam num caixa próprio, fora das despesas da casa.

ALTER TABLE app_user ADD COLUMN is_guardian BOOLEAN NOT NULL DEFAULT false;  -- pode registrar ocorrências e corrigir hábitos
UPDATE app_user SET is_guardian = true WHERE role = 'ADMIN';

CREATE TYPE conduct_kind AS ENUM ('HABIT', 'INFRACTION');

CREATE TABLE conduct_rule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code TEXT NOT NULL REFERENCES entity(code) CHECK (entity_code = 'PERSONAL'),
  kind        conduct_kind NOT NULL,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  points      INTEGER NOT NULL DEFAULT 1 CHECK (points BETWEEN 0 AND 1000),       -- pontos perdidos por falta/ocorrência
  fine_cents  BIGINT NOT NULL DEFAULT 0 CHECK (fine_cents BETWEEN 0 AND 100000000), -- multa em centavos (0 = sem multa)
  sort        INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  starts_on   DATE NOT NULL DEFAULT current_date,                                  -- hábito só cobra a partir daqui
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX conduct_rule_name_uq ON conduct_rule (entity_code, kind, lower(name));

-- Marcação de hábito feito (a pessoa marca; responsável pode corrigir).
CREATE TABLE habit_check (
  person_id  UUID NOT NULL REFERENCES person(id),
  rule_id    UUID NOT NULL REFERENCES conduct_rule(id),
  day        DATE NOT NULL,
  checked_by UUID REFERENCES app_user(id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, rule_id, day)
);

-- Livro do placar: faltas de hábito, ocorrências, pagamentos e perdões de multa.
CREATE TYPE conduct_entry_kind AS ENUM ('HABIT_MISS', 'INFRACTION', 'PAYMENT', 'WAIVER');
CREATE TABLE conduct_entry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    UUID NOT NULL REFERENCES person(id),
  kind         conduct_entry_kind NOT NULL,
  rule_id      UUID REFERENCES conduct_rule(id),
  day          DATE NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),  -- multa (MISS/INFRACTION) ou valor quitado (PAYMENT/WAIVER)
  note         TEXT,
  created_by   UUID REFERENCES app_user(id),
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind IN ('HABIT_MISS', 'INFRACTION')) = (rule_id IS NOT NULL))
);
-- Falta de hábito é gerada uma vez por pessoa/hábito/dia (idempotente).
CREATE UNIQUE INDEX conduct_miss_uq ON conduct_entry (person_id, rule_id, day) WHERE kind = 'HABIT_MISS';
CREATE INDEX conduct_entry_person_day_idx ON conduct_entry (person_id, day) WHERE deleted_at IS NULL;

CREATE TRIGGER conduct_rule_audit  BEFORE INSERT OR UPDATE OR DELETE ON conduct_rule  FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER conduct_entry_audit BEFORE INSERT OR UPDATE OR DELETE ON conduct_entry FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER conduct_entry_nodelete BEFORE DELETE ON conduct_entry FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Regras iniciais pedidas pelo Marcos. Valores de multa ficam R$ 0 até ele definir (não inventamos valor).
INSERT INTO conduct_rule (entity_code, kind, name, points, fine_cents, sort) VALUES
  ('PERSONAL', 'HABIT', 'Dormiu na hora', 1, 0, 1),
  ('PERSONAL', 'HABIT', 'Estudou', 1, 0, 2),
  ('PERSONAL', 'HABIT', 'Treinou', 1, 0, 3),
  ('PERSONAL', 'HABIT', 'Orou', 1, 0, 4),
  ('PERSONAL', 'INFRACTION', 'Foi grosso(a) com os pais', 3, 0, 1),
  ('PERSONAL', 'INFRACTION', 'Foi grosso(a) com a irmã', 2, 0, 2),
  ('PERSONAL', 'INFRACTION', 'Falou palavrão', 1, 0, 3);
