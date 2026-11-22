-- 1) Fechamento automático: o mês M trava no dia 5 de M+1 (horário de Brasília).
--    Depois disso, só o root grava/corrige algo com data naquele mês. A regra mora no banco:
--    vale para a tela, para a API e para qualquer script. Gravações do sistema (sem usuário) passam.
CREATE OR REPLACE FUNCTION month_locked(d DATE) RETURNS BOOLEAN AS $$
  SELECT d IS NOT NULL AND (now() AT TIME ZONE 'America/Sao_Paulo')::date >= (date_trunc('month', d) + interval '1 month' + interval '4 days')::date
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION actor_can_edit_closed() RETURNS BOOLEAN AS $$
  SELECT audit_actor() IS NULL OR COALESCE((SELECT is_root FROM app_user WHERE id = audit_actor()), false)
$$ LANGUAGE sql STABLE;

-- Gatilho genérico: TG_ARGV[0] = coluna de data que define o mês do registro.
CREATE OR REPLACE FUNCTION closed_month_guard() RETURNS trigger AS $$
DECLARE col TEXT := TG_ARGV[0]; d_old DATE; d_new DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN d_old := (to_jsonb(OLD)->>col)::date; END IF;
  IF TG_OP <> 'DELETE' THEN d_new := (to_jsonb(NEW)->>col)::date; END IF;
  -- Faltas geradas automaticamente pelo sistema não são edição de usuário.
  IF TG_TABLE_NAME = 'conduct_entry' AND TG_OP = 'INSERT' THEN
    IF to_jsonb(NEW)->>'kind' = 'HABIT_MISS' AND to_jsonb(NEW)->>'created_by' IS NULL THEN RETURN NEW; END IF;
  END IF;
  IF (month_locked(d_old) OR month_locked(d_new)) AND NOT actor_can_edit_closed() THEN
    RAISE EXCEPTION 'Mês %/% já está fechado. Só o root pode corrigir.',
      to_char(COALESCE(CASE WHEN month_locked(d_old) THEN d_old END, d_new), 'MM'), to_char(COALESCE(CASE WHEN month_locked(d_old) THEN d_old END, d_new), 'YYYY')
      USING ERRCODE = 'MTSM1';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_closed BEFORE INSERT OR UPDATE OR DELETE ON settlement FOR EACH ROW EXECUTE FUNCTION closed_month_guard('paid_on');
CREATE TRIGGER transfer_closed BEFORE INSERT OR UPDATE OR DELETE ON transfer FOR EACH ROW EXECUTE FUNCTION closed_month_guard('day');
CREATE TRIGGER habit_check_closed BEFORE INSERT OR UPDATE OR DELETE ON habit_check FOR EACH ROW EXECUTE FUNCTION closed_month_guard('day');
CREATE TRIGGER conduct_entry_closed BEFORE INSERT OR UPDATE OR DELETE ON conduct_entry FOR EACH ROW EXECUTE FUNCTION closed_month_guard('day');
CREATE TRIGGER allowance_closing_closed BEFORE INSERT OR UPDATE OR DELETE ON allowance_closing FOR EACH ROW EXECUTE FUNCTION closed_month_guard('month');

-- Conta já paga num mês fechado: valor, juros e exclusão também ficam travados.
CREATE OR REPLACE FUNCTION title_closed_guard() RETURNS trigger AS $$
BEGIN
  IF (OLD.amount_cents IS DISTINCT FROM NEW.amount_cents OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.interest_model IS DISTINCT FROM NEW.interest_model OR OLD.rate_bp IS DISTINCT FROM NEW.rate_bp)
     AND EXISTS (SELECT 1 FROM settlement s WHERE s.title_id = OLD.id AND s.deleted_at IS NULL AND month_locked(s.paid_on))
     AND NOT actor_can_edit_closed() THEN
    RAISE EXCEPTION 'Esta conta tem pagamento num mês já fechado. Só o root pode corrigir.' USING ERRCODE = 'MTSM1';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER title_closed BEFORE UPDATE ON title FOR EACH ROW EXECUTE FUNCTION title_closed_guard();

-- 2) Check com aprovação: quem tem perfil "só combinados" marca, e um responsável aprova.
--    Só check aprovado conta na nota.
ALTER TABLE habit_check ADD COLUMN approved BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE habit_check ADD COLUMN approved_by UUID REFERENCES app_user(id);
ALTER TABLE habit_check ADD COLUMN approved_at TIMESTAMPTZ;
CREATE INDEX habit_check_pending_idx ON habit_check (day) WHERE NOT approved;
