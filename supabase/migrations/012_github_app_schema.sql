-- Migration 012: GitHub App support
-- Adds 'github' to cb_provider enum + 3 new tables for installations, repos, audit log

-- 1. Extend provider enum
ALTER TYPE cb_provider ADD VALUE IF NOT EXISTS 'github';


-- 2. Installations: one row per GitHub App installation
CREATE TABLE cb_github_installations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES cb_users(id) ON DELETE CASCADE,
  installation_id     bigint NOT NULL UNIQUE,
  account_login       text NOT NULL,
  account_type        text NOT NULL CHECK (account_type IN ('User','Organization')),
  account_id          bigint NOT NULL,
  account_avatar_url  text,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  uninstalled_at      timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cb_github_installations_user
  ON cb_github_installations(user_id);

CREATE INDEX idx_cb_github_installations_active
  ON cb_github_installations(installation_id)
  WHERE uninstalled_at IS NULL;


-- 3. Repos: per-installation repo selection, 1:1 with cb_sources
CREATE TABLE cb_github_repos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id     uuid NOT NULL REFERENCES cb_github_installations(id) ON DELETE CASCADE,
  source_id           uuid NOT NULL UNIQUE REFERENCES cb_sources(id) ON DELETE CASCADE,
  github_repo_id      bigint NOT NULL,
  owner               text NOT NULL,
  name                text NOT NULL,
  default_branch      text NOT NULL DEFAULT 'main',
  selected_branch     text NOT NULL,
  is_private          boolean NOT NULL DEFAULT false,
  last_synced_sha     text,
  last_synced_at      timestamptz,
  last_sync_status    text CHECK (last_sync_status IN ('pending','syncing','success','failed')),
  last_sync_error     text,
  files_synced_count  integer NOT NULL DEFAULT 0,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, github_repo_id)
);

CREATE INDEX idx_cb_github_repos_installation ON cb_github_repos(installation_id);
CREATE INDEX idx_cb_github_repos_source       ON cb_github_repos(source_id);


-- 4. Deletion audit log (F2)
CREATE TABLE cb_github_deletion_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES cb_users(id) ON DELETE SET NULL,
  installation_id        bigint,
  github_repo_id         bigint,
  repo_full_name         text,
  source_id              uuid,
  trigger_type           text NOT NULL CHECK (trigger_type IN ('user_disconnect','admin','uninstall_webhook','app_uninstalled')),
  reason                 text,
  chunks_deleted         integer NOT NULL DEFAULT 0,
  files_deleted          integer NOT NULL DEFAULT 0,
  conversations_flagged  integer NOT NULL DEFAULT 0,
  triggered_at           timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  error                  text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_cb_github_deletion_log_user         ON cb_github_deletion_log(user_id);
CREATE INDEX idx_cb_github_deletion_log_installation ON cb_github_deletion_log(installation_id);
CREATE INDEX idx_cb_github_deletion_log_triggered    ON cb_github_deletion_log(triggered_at DESC);


-- 5. updated_at trigger
CREATE OR REPLACE FUNCTION cb_github_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cb_github_installations_updated_at
  BEFORE UPDATE ON cb_github_installations
  FOR EACH ROW EXECUTE FUNCTION cb_github_update_timestamp();

CREATE TRIGGER cb_github_repos_updated_at
  BEFORE UPDATE ON cb_github_repos
  FOR EACH ROW EXECUTE FUNCTION cb_github_update_timestamp();
