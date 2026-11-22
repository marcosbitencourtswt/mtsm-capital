-- "Nome sujo": dívida/produto negativado (Serasa/SPC). Ajuda a decidir a estratégia "limpar o nome".
ALTER TABLE account ADD COLUMN negativado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE title   ADD COLUMN negativado BOOLEAN NOT NULL DEFAULT false;
