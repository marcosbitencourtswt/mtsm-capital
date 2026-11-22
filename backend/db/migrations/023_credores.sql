-- Credores: o cadastro de "instituição" passa a valer também para pessoas (ex.: um amigo que emprestou dinheiro).
-- Fica separado das Pessoas da casa (família), que mandam em combinados, ranking e "De quem é".
-- E-mail e telefone são opcionais e servem só para lembretes futuros (dado de terceiro: guardar o mínimo).
ALTER TABLE institution
  ADD COLUMN kind  TEXT NOT NULL DEFAULT 'EMPRESA' CHECK (kind IN ('EMPRESA', 'PESSOA')),
  ADD COLUMN email TEXT CHECK (email IS NULL OR (length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD COLUMN phone TEXT CHECK (phone IS NULL OR length(phone) <= 30),
  ADD COLUMN notes TEXT CHECK (notes IS NULL OR length(notes) <= 300);
