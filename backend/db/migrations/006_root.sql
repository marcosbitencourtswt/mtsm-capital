-- Usuário root: o dono do sistema (criado na instalação). Único, não pode ser desativado nem rebaixado.
ALTER TABLE app_user ADD COLUMN is_root BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX app_user_single_root ON app_user (is_root) WHERE is_root;
ALTER TABLE app_user ADD CONSTRAINT root_is_active_admin CHECK (NOT is_root OR (role = 'ADMIN' AND active AND is_guardian));
-- Sistemas já instalados: o administrador mais antigo vira root.
UPDATE app_user SET is_root = true
WHERE id = (SELECT id FROM app_user WHERE role = 'ADMIN' AND active ORDER BY created_at LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM app_user WHERE is_root);
