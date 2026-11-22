-- Uso da leitura de foto (OCR): só para o limite diário por pessoa. A foto em si não é guardada.
CREATE TABLE ocr_usage (
  user_id UUID NOT NULL REFERENCES app_user(id),
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ocr_usage_idx ON ocr_usage (user_id, at);
