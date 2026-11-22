-- Perfil "só combinados" (ex.: criança ou adolescente): vê e marca só as tarefas e a mesada dela; nada de finanças.
ALTER TABLE app_user ADD COLUMN conduct_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_user ADD CONSTRAINT app_user_conduct_only_member CHECK (NOT conduct_only OR (role = 'MEMBER' AND NOT is_guardian AND NOT is_root));
