-- ============================================================
-- Migration: adicionar colunas de YouTube Shorts em etica_dicas
-- Aplicar antes de ativar o workflow EURETwY9ucilW8aq
-- ============================================================

ALTER TABLE etica_dicas
  ADD COLUMN IF NOT EXISTS shorts_postada BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shorts_postada_em TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS youtube_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS youtube_url TEXT NULL;

-- Indice util para queries de "qual ainda nao virou Short"
CREATE INDEX IF NOT EXISTS idx_etica_dicas_shorts_postada
  ON etica_dicas(shorts_postada)
  WHERE shorts_postada = FALSE;

-- Verificar
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'etica_dicas'
  AND column_name IN ('shorts_postada', 'shorts_postada_em', 'youtube_id', 'youtube_url')
ORDER BY column_name;
