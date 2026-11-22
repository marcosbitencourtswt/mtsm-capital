-- Combinados v2: tarefas atribuídas por pessoa (diária, revezamento, avulsa), mesada mensal proporcional.

-- Frequência da tarefa:
--   DAILY    = todo dia, para cada pessoa atribuída
--   ROTATION = revezamento diário entre as pessoas atribuídas (na ordem de "position")
--   SPORADIC = avulsa: só vale nos dias em que um responsável ativar para a pessoa
ALTER TABLE conduct_rule ADD COLUMN schedule TEXT NOT NULL DEFAULT 'DAILY' CHECK (schedule IN ('DAILY', 'ROTATION', 'SPORADIC'));
ALTER TABLE conduct_rule ADD COLUMN description TEXT;

-- Quem faz cada tarefa. Tarefa sem ninguém atribuído não vale para ninguém.
CREATE TABLE conduct_assignment (
  rule_id   UUID NOT NULL REFERENCES conduct_rule(id),
  person_id UUID NOT NULL REFERENCES person(id),
  position  INTEGER NOT NULL DEFAULT 0,  -- ordem do revezamento
  PRIMARY KEY (rule_id, person_id)
);
-- Regras antigas (v1 valiam para todos): passam a valer para quem já existia.
INSERT INTO conduct_assignment (rule_id, person_id, position)
SELECT r.id, p.id, row_number() OVER (PARTITION BY r.id ORDER BY p.name)
FROM conduct_rule r CROSS JOIN person p
WHERE r.kind = 'HABIT' AND p.entity_code = 'PERSONAL' AND p.active;

-- Tarefa avulsa ativada para um dia (ex.: "Cuidar da irmã" hoje para a Sara).
CREATE TABLE conduct_sporadic (
  rule_id     UUID NOT NULL REFERENCES conduct_rule(id),
  person_id   UUID NOT NULL REFERENCES person(id),
  day         DATE NOT NULL,
  assigned_by UUID REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, person_id, day)
);

-- Plano de recompensa por pessoa.
--   MONEY = mesada em dinheiro proporcional à nota · STARS = estrelas (crianças) · NONE = só participa da nota
CREATE TABLE allowance_plan (
  person_id    UUID PRIMARY KEY REFERENCES person(id),
  mode         TEXT NOT NULL DEFAULT 'NONE' CHECK (mode IN ('MONEY', 'STARS', 'NONE')),
  amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents BETWEEN 0 AND 100000000),
  consequence  TEXT,                      -- o que acontece se a nota zerar (ex.: "Sem celular")
  deduct_fines BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fechamento mensal (um por pessoa por mês). A mesada vira conta a pagar.
CREATE TABLE allowance_closing (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id            UUID NOT NULL REFERENCES person(id),
  month                DATE NOT NULL CHECK (extract(day FROM month) = 1),
  mode                 TEXT NOT NULL,
  percent              NUMERIC(5,2) NOT NULL,
  done                 INTEGER NOT NULL,
  due                  INTEGER NOT NULL,
  penalty_points       INTEGER NOT NULL,
  base_cents           BIGINT NOT NULL,
  fines_deducted_cents BIGINT NOT NULL DEFAULT 0,
  payout_cents         BIGINT NOT NULL,
  stars                INTEGER NOT NULL DEFAULT 0,
  consequence          TEXT,
  title_id             UUID REFERENCES title(id),
  created_by           UUID REFERENCES app_user(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, month)
);
CREATE TRIGGER allowance_plan_audit    BEFORE INSERT OR UPDATE OR DELETE ON allowance_plan    FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER allowance_closing_audit BEFORE INSERT OR UPDATE OR DELETE ON allowance_closing FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- Auditoria: tabelas sem coluna "id" (allowance_plan) usam person_id como identificador.
CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data)
  VALUES (TG_TABLE_NAME,
          COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id', to_jsonb(NEW)->>'key', to_jsonb(OLD)->>'key',
                   to_jsonb(NEW)->>'person_id', to_jsonb(OLD)->>'person_id', '?'),
          TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
