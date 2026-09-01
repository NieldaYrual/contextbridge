-- Add importance_score column to cb_files
-- Migration created: 2025-11-11
-- Reason: capture code requires this column but it was missing from schema

ALTER TABLE cb_files 
ADD COLUMN IF NOT EXISTS importance_score REAL DEFAULT 0.5;

-- Add index for potential queries
CREATE INDEX IF NOT EXISTS idx_cb_files_importance 
ON cb_files(importance_score DESC);

-- Verify
COMMENT ON COLUMN cb_files.importance_score IS 'Importance score for ranking files (0.0-1.0)';