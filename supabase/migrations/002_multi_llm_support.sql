-- Add LLM provider support
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS llm_provider TEXT DEFAULT 'claude';

-- Update artifact types to be more general
ALTER TABLE artifacts 
DROP CONSTRAINT IF EXISTS artifacts_type_check;

ALTER TABLE artifacts 
ADD CONSTRAINT artifacts_type_check 
CHECK (type IN ('code', 'decision', 'requirement', 'architecture', 'document', 'link', 'general'));

-- Add index for LLM provider
CREATE INDEX IF NOT EXISTS idx_conversations_llm_provider ON conversations(llm_provider);

-- Add URLs/links tracking table (optional, for dedicated URL management)
CREATE TABLE IF NOT EXISTS extracted_urls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extracted_urls_project ON extracted_urls(project_id);