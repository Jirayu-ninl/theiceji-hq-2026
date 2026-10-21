-- Restore what the 0000 squash dropped (2ce7300, 2026-09-27).
-- drizzle-kit writes only what the schema files express, so squashing 0000–0009 into 0000_familiar_thor lost every
-- hand-written statement. A catalog diff of a database built from the old chain against one built from the squash
-- found exactly these missing, and nothing else: 5 trigger functions, the 14 history guards that
-- packages/hq-db/src/readiness.ts (REQUIRED_TRIGGERS) and `db:check` require, and notes_project_owner_fk.
-- The statements are the old 0002, 0003, 0005 and 0009 verbatim, made safe to run on a database that still has them
-- (one migrated before the squash): functions are replaced, triggers dropped and recreated, the FK added only when
-- missing.
--
-- ops history is append-only. A policy revision, a run checkpoint, a usage
-- event, an audit event, a capability check and a human response are never
-- updated or deleted once written; the next revision is a new row.
-- TRUNCATE is unaffected. (old 0002)
CREATE OR REPLACE FUNCTION "ops_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_policies_append_only" ON "ops_policies";--> statement-breakpoint
CREATE TRIGGER "ops_policies_append_only" BEFORE UPDATE OR DELETE ON "ops_policies" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_run_checkpoints_append_only" ON "ops_run_checkpoints";--> statement-breakpoint
CREATE TRIGGER "ops_run_checkpoints_append_only" BEFORE UPDATE OR DELETE ON "ops_run_checkpoints" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_usage_events_append_only" ON "ops_usage_events";--> statement-breakpoint
CREATE TRIGGER "ops_usage_events_append_only" BEFORE UPDATE OR DELETE ON "ops_usage_events" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_audit_events_append_only" ON "ops_audit_events";--> statement-breakpoint
CREATE TRIGGER "ops_audit_events_append_only" BEFORE UPDATE OR DELETE ON "ops_audit_events" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_capability_checks_append_only" ON "ops_capability_checks";--> statement-breakpoint
CREATE TRIGGER "ops_capability_checks_append_only" BEFORE UPDATE OR DELETE ON "ops_capability_checks" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_human_responses_append_only" ON "ops_human_responses";--> statement-breakpoint
CREATE TRIGGER "ops_human_responses_append_only" BEFORE UPDATE OR DELETE ON "ops_human_responses" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
-- A release authorization's target is what it authorizes. Only its state may
-- move (active → consumed / revoked / expired), and never back. (old 0002)
CREATE OR REPLACE FUNCTION "ops_guard_release_authorization"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ops_release_authorizations rows are append-only (DELETE refused)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'ops_release_authorizations: a % authorization is final', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.module IS DISTINCT FROM OLD.module
    OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.asset_sha256 IS DISTINCT FROM OLD.asset_sha256
    OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.quality_check_ids IS DISTINCT FROM OLD.quality_check_ids
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'ops_release_authorizations: only the state of an authorization can change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ops_release_authorizations_guard" ON "ops_release_authorizations";--> statement-breakpoint
CREATE TRIGGER "ops_release_authorizations_guard" BEFORE UPDATE OR DELETE ON "ops_release_authorizations" FOR EACH ROW EXECUTE FUNCTION "ops_guard_release_authorization"();--> statement-breakpoint
-- A card's history is append-only, like the ops kernel's. (old 0003)
DROP TRIGGER IF EXISTS "board_card_events_append_only" ON "board_card_events";--> statement-breakpoint
CREATE TRIGGER "board_card_events_append_only" BEFORE UPDATE OR DELETE ON "board_card_events" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
-- A ready asset is what prompt examples, quote PDFs and posts point at: its
-- identity (where the bytes are, how many, their hash and type, whose and
-- which project) never changes. It may only become `rejected` — the ops tick
-- does that when the file has vanished from its storage — and only the owner
-- deletes one (the service's rule; the database allows the delete). (old 0003)
CREATE OR REPLACE FUNCTION "asset_freeze_ready"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' AND (
    NEW.status NOT IN ('ready', 'rejected')
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.bytes IS DISTINCT FROM OLD.bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.mime IS DISTINCT FROM OLD.mime
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
  ) THEN
    RAISE EXCEPTION 'asset_assets: a ready asset''s identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "asset_assets_freeze_ready" ON "asset_assets";--> statement-breakpoint
CREATE TRIGGER "asset_assets_freeze_ready" BEFORE UPDATE ON "asset_assets" FOR EACH ROW EXECUTE FUNCTION "asset_freeze_ready"();--> statement-breakpoint
-- What a client was sent stays what they were sent. Once a quote leaves
-- draft, its money (currency, VAT, WHT, the frozen totals), its number, its
-- client, its dates and its PDF don't change — only its status moves on
-- (accepted / declined / expired), or back to draft to revise it, which
-- clears the send and starts over. Its lines follow the same rule. (old 0003)
CREATE OR REPLACE FUNCTION "quote_freeze_sent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'quote_quotes: only a draft quote can be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND NEW.status <> 'draft' AND (
    NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.vat_pct IS DISTINCT FROM OLD.vat_pct
    OR NEW.wht_pct IS DISTINCT FROM OLD.wht_pct
    OR NEW.totals_snapshot IS DISTINCT FROM OLD.totals_snapshot
    OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.pdf_asset_id IS DISTINCT FROM OLD.pdf_asset_id
  ) THEN
    RAISE EXCEPTION 'quote_quotes: a sent quote is frozen — revise it back to draft first'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "quote_quotes_freeze_sent" ON "quote_quotes";--> statement-breakpoint
CREATE TRIGGER "quote_quotes_freeze_sent" BEFORE UPDATE OR DELETE ON "quote_quotes" FOR EACH ROW EXECUTE FUNCTION "quote_freeze_sent"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "quote_freeze_sent_lines"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM "quote_quotes"
    WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  -- The parent is gone (a draft being deleted cascades here): nothing to guard.
  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'quote_lines: a sent quote''s lines are frozen — revise it back to draft first'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "quote_lines_freeze_sent" ON "quote_lines";--> statement-breakpoint
CREATE TRIGGER "quote_lines_freeze_sent" BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines" FOR EACH ROW EXECUTE FUNCTION "quote_freeze_sent_lines"();--> statement-breakpoint
-- Readings, money lines and verdicts are history: a correction is a new row
-- that supersedes the old one, never an edit. (old 0005)
DROP TRIGGER IF EXISTS "publish_readings_append_only" ON "publish_readings";--> statement-breakpoint
CREATE TRIGGER "publish_readings_append_only" BEFORE UPDATE OR DELETE ON "publish_readings" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "market_sales_events_append_only" ON "market_sales_events";--> statement-breakpoint
CREATE TRIGGER "market_sales_events_append_only" BEFORE UPDATE OR DELETE ON "market_sales_events" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "exp_decisions_append_only" ON "exp_decisions";--> statement-breakpoint
CREATE TRIGGER "exp_decisions_append_only" BEFORE UPDATE OR DELETE ON "exp_decisions" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();--> statement-breakpoint
-- A note is filed only under a project of its own owner. When the project
-- goes, only project_id clears (PostgreSQL 15+ column list) — the note stays.
-- Written by hand: drizzle can't express the column list. (old 0009)
UPDATE "notes" SET "project_id" = NULL WHERE "project_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = "notes"."project_id" AND p."owner_id" = "notes"."owner_id");--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_project_owner_fk' AND conrelid = '"notes"'::regclass) THEN
    ALTER TABLE "notes" ADD CONSTRAINT "notes_project_owner_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE SET NULL ("project_id") ON UPDATE no action;
  END IF;
END;
$$;
