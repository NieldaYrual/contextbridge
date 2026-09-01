-- Migration 013: GitHub schema fixes (2026-04-26)
-- 1. Allow NULL user_id on cb_github_installations (backstop pattern: webhook
--    creates orphan rows before the setup redirect links them to a user).
ALTER TABLE cb_github_installations
ALTER COLUMN user_id DROP NOT NULL;

-- 2. Drop overly restrictive unique constraint on cb_github_repos.
--    The old (installation_id, github_repo_id) unique prevented linking one repo
--    to multiple projects. Each project gets its own cb_sources → cb_github_repos
--    pair, so the same repo can appear multiple times per installation.
ALTER TABLE cb_github_repos
DROP CONSTRAINT cb_github_repos_installation_id_github_repo_id_key;