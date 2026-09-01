-- Current State Documentation (before embedding fix)
-- Generated: 2025-11-11
-- Purpose: Document schema state before fixing embedding batch failure bug

-- CRITICAL FUNCTIONS FOR EMBEDDING SYSTEM
-- These are the RPC functions called by the backfill endpoints

-- 1. cb_next_files_to_embed - finds files needing embeddings
-- 2. cb_next_messages_to_embed - finds messages needing embeddings  
-- 3. cb_next_blocks_to_embed - finds blocks needing embeddings
-- 4. cb_next_conversations_to_embed - finds conversations needing embeddings

-- See individual function files in /functions directory

-- KNOWN ISSUES (as of 2025-11-11):
-- 1. Backfill endpoints had no try-catch per item, causing batch poisoning
-- 2. 78% of files missing embeddings (1,863 of 2,394)
-- 3. Single file error would fail entire batch and prevent retries

-- FIX APPLIED:
-- Added try-catch around each item in batch processing loops for:
-- - /_backfill/embeddings/files
-- - /_backfill/embeddings/messages
-- - /_backfill/embeddings/blocks
-- - /_backfill/embeddings/conversations

-- KEY TABLES:
-- cb_files - stores captured file content
-- cb_file_embeddings - stores embeddings for files
-- cb_messages - stores conversation messages
-- cb_message_embeddings - stores embeddings for messages
-- cb_blocks - stores code blocks
-- block_embeddings - stores embeddings for blocks

-- NEXT STEPS:
-- 1. Test with 3 conversations
-- 2. If successful, re-embed entire project
-- 3. Verify file embedding success rate improves from 22% to ~95%+