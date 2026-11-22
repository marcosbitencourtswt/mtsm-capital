-- Baixa com desconto (ex.: dívida de 1.800 quitada por 1.500): a diferença vira um registro
-- do tipo DISCOUNT — fecha o saldo, não sai de nenhuma conta e não conta como despesa.
ALTER TYPE pay_method ADD VALUE IF NOT EXISTS 'DISCOUNT';
