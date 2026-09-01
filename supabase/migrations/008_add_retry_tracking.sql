-- Migration: Add retry tracking to embedding tables
-- Date: 2025-11-14
-- Purpose: Enable automatic retry logic for failed embeddings

-- Add retry tracking to message embeddings
ALTER TABLE cb_message_embeddings 
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';

-- Add retry tracking to file embeddings
ALTER TABLE cb_file_embeddings 
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';

-- Add retry tracking to block embeddings
ALTER TABLE cb_block_embeddings 
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';

-- Add retry tracking to conversation embeddings
ALTER TABLE cb_conversation_embeddings 
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';

-- Add indexes for efficient retry queries
CREATE INDEX IF NOT EXISTS idx_message_embeddings_status ON cb_message_embeddings(status, retry_count);
CREATE INDEX IF NOT EXISTS idx_file_embeddings_status ON cb_file_embeddings(status, retry_count);
CREATE INDEX IF NOT EXISTS idx_block_embeddings_status ON cb_block_embeddings(status, retry_count);
CREATE INDEX IF NOT EXISTS idx_conversation_embeddings_status ON cb_conversation_embeddings(status, retry_count);

-- Add comments for documentation
COMMENT ON COLUMN cb_message_embeddings.retry_count IS 'Number of retry attempts for this embedding';
COMMENT ON COLUMN cb_message_embeddings.last_error IS 'Error message from last failed attempt';
COMMENT ON COLUMN cb_message_embeddings.last_attempted_at IS 'Timestamp of last embedding attempt';
COMMENT ON COLUMN cb_message_embeddings.status IS 'Status: pending, success, failed, max_retries_exceeded';