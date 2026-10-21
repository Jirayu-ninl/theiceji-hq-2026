-- Board · Clients · Follow-ups · Payments (2026-09-27).
-- 1. quote_clients becomes HQ's clients: one record that Board cards and Quotes both point at.
ALTER TABLE "quote_clients" RENAME TO "clients";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_pkey" TO "clients_pkey";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_owner_scope_key" TO "clients_owner_scope_key";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_name_check" TO "clients_name_check";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_address_check" TO "clients_address_check";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_tax_check" TO "clients_tax_check";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_created_by_users_id_fk" TO "clients_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "quote_clients_owner_id_users_id_fk" TO "clients_owner_id_users_id_fk";
--> statement-breakpoint
ALTER INDEX "quote_clients_name_key" RENAME TO "clients_name_key";
--> statement-breakpoint
-- Postgres 18 names NOT NULL constraints after the table they were made on; rename those too (older versions
-- don't name them, and this finds nothing).
DO $$
DECLARE
  old_name text;
BEGIN
  FOR old_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"clients"'::regclass AND conname LIKE 'quote\_clients\_%\_not\_null'
  LOOP
    EXECUTE format('ALTER TABLE "clients" RENAME CONSTRAINT %I TO %I', old_name, substr(old_name, 7));
  END LOOP;
END;
$$;
--> statement-breakpoint
-- 2. A card points at a client (or keeps a name used once), carries a colour, and its money: total = price + the
--    follow-ups' prices, paid_total = the payments that count.
ALTER TABLE "board_cards" ADD COLUMN "client_id" uuid;
--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "total" numeric(12, 2);
--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "paid_total" numeric(12, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
-- Backfill: no card has follow-ups yet, so its total is its price. A card already marked paid was paid in full.
-- A card whose client name is exactly one of the owner's active clients now points at that client.
UPDATE "board_cards" SET "total" = "price";
--> statement-breakpoint
UPDATE "board_cards" SET "paid_total" = "price" WHERE "paid_at" IS NOT NULL AND "price" IS NOT NULL;
--> statement-breakpoint
UPDATE "board_cards" AS c SET "client_id" = cl."id", "client" = NULL
  FROM "clients" AS cl
  WHERE c."client_id" IS NULL AND c."client" IS NOT NULL AND cl."owner_id" = c."owner_id"
    AND cl."archived_at" IS NULL AND lower(btrim(c."client")) = lower(cl."name");
--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_client_one_check" CHECK ("board_cards"."client_id" is null or "board_cards"."client" is null);
--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_color_check" CHECK ("board_cards"."color" is null or "board_cards"."color" in ('violet', 'teal', 'blue', 'pink', 'grey', 'orange', 'mint', 'gold', 'lavender', 'sky'));
--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_total_check" CHECK ("board_cards"."total" is null or ("board_cards"."total" >= 0 and "board_cards"."currency" is not null));
--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_paid_total_check" CHECK ("board_cards"."paid_total" >= 0 and ("board_cards"."paid_total" = 0 or "board_cards"."currency" is not null));
--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_client_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."clients"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "board_cards_client_idx" ON "board_cards" USING btree ("owner_id","client_id") WHERE "board_cards"."client_id" is not null;
--> statement-breakpoint
-- 3. Follow-ups: work that came after a card's own task was done.
CREATE TABLE "board_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"price" numeric(12, 2),
	"due_on" date,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "board_followups_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "board_followups_title_check" CHECK (length(btrim("board_followups"."title")) between 1 and 200),
	CONSTRAINT "board_followups_body_check" CHECK (length("board_followups"."body") <= 20000),
	CONSTRAINT "board_followups_price_check" CHECK ("board_followups"."price" is null or "board_followups"."price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "board_followups" ADD CONSTRAINT "board_followups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_followups" ADD CONSTRAINT "board_followups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_followups" ADD CONSTRAINT "board_followups_card_fk" FOREIGN KEY ("card_id","owner_id") REFERENCES "public"."board_cards"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_followups" ADD CONSTRAINT "board_followups_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "board_followups_card_idx" ON "board_followups" USING btree ("card_id","position") WHERE "board_followups"."archived_at" is null;
--> statement-breakpoint
-- 4. The payment ledger: deposits, part payments, the rest at Mark paid, and voids that strike a line.
CREATE TABLE "board_card_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"received_on" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"voids_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_card_payments_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "board_card_payments_kind_check" CHECK ("board_card_payments"."kind" in ('deposit', 'part', 'final', 'void')),
	CONSTRAINT "board_card_payments_amount_check" CHECK ("board_card_payments"."amount" > 0),
	CONSTRAINT "board_card_payments_currency_check" CHECK ("board_card_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "board_card_payments_note_check" CHECK (length("board_card_payments"."note") <= 200),
	CONSTRAINT "board_card_payments_void_check" CHECK (("board_card_payments"."kind" = 'void') = ("board_card_payments"."voids_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "board_card_payments" ADD CONSTRAINT "board_card_payments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_card_payments" ADD CONSTRAINT "board_card_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_card_payments" ADD CONSTRAINT "board_card_payments_card_fk" FOREIGN KEY ("card_id","owner_id") REFERENCES "public"."board_cards"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_card_payments" ADD CONSTRAINT "board_card_payments_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_card_payments" ADD CONSTRAINT "board_card_payments_voids_fk" FOREIGN KEY ("voids_id","owner_id") REFERENCES "public"."board_card_payments"("id","owner_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "board_card_payments_voids_key" ON "board_card_payments" USING btree ("voids_id") WHERE "board_card_payments"."voids_id" is not null;
--> statement-breakpoint
CREATE INDEX "board_card_payments_card_idx" ON "board_card_payments" USING btree ("card_id","created_at");
--> statement-breakpoint
CREATE INDEX "board_card_payments_owner_idx" ON "board_card_payments" USING btree ("owner_id","received_on");
--> statement-breakpoint
-- Backfill: every card marked paid before the ledger existed gets its one final payment, on the day it was
-- marked paid in its project's own calendar, so Readings and Home keep counting it as money in.
INSERT INTO "board_card_payments" ("owner_id", "card_id", "project_id", "kind", "amount", "currency", "received_on", "note", "created_by", "created_at")
  SELECT c."owner_id", c."id", c."project_id", 'final', c."price", c."currency",
    (c."paid_at" AT TIME ZONE COALESCE(p."timezone", 'Asia/Bangkok'))::date,
    'marked paid before payments were recorded', c."owner_id", c."paid_at"
  FROM "board_cards" AS c
  LEFT JOIN "projects" AS p ON p."id" = c."project_id"
  WHERE c."paid_at" IS NOT NULL AND c."price" IS NOT NULL AND c."price" > 0;
--> statement-breakpoint
-- 5. The new history kinds, link type and link role.
ALTER TABLE "board_card_events" DROP CONSTRAINT "board_card_events_kind_check";
--> statement-breakpoint
ALTER TABLE "board_card_events" ADD CONSTRAINT "board_card_events_kind_check" CHECK ("board_card_events"."kind" in ('created', 'moved', 'edited', 'priced', 'paid', 'unpaid', 'archived', 'restored', 'followup_added', 'followup_edited', 'followup_removed', 'payment_recorded', 'payment_voided'));
--> statement-breakpoint
ALTER TABLE "refs" DROP CONSTRAINT "refs_from_type_check";
--> statement-breakpoint
ALTER TABLE "refs" ADD CONSTRAINT "refs_from_type_check" CHECK ("refs"."from_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request', 'followup'));
--> statement-breakpoint
ALTER TABLE "refs" DROP CONSTRAINT "refs_to_type_check";
--> statement-breakpoint
ALTER TABLE "refs" ADD CONSTRAINT "refs_to_type_check" CHECK ("refs"."to_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request', 'followup'));
--> statement-breakpoint
ALTER TABLE "refs" DROP CONSTRAINT "refs_role_check";
--> statement-breakpoint
ALTER TABLE "refs" ADD CONSTRAINT "refs_role_check" CHECK ("refs"."role" in ('promoted_to', 'attached', 'example_of', 'result_of', 'scheduled_as', 'quoted_by', 'published_as', 'listed_as', 'proposed_as', 'produced_by', 'made_with'));
--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" DROP CONSTRAINT "asset_generation_jobs_target_type_check";
--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_target_type_check" CHECK ("asset_generation_jobs"."target_type" is null or "asset_generation_jobs"."target_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request', 'followup'));
--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" DROP CONSTRAINT "asset_generation_jobs_target_role_check";
--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_target_role_check" CHECK ("asset_generation_jobs"."target_role" is null or "asset_generation_jobs"."target_role" in ('promoted_to', 'attached', 'example_of', 'result_of', 'scheduled_as', 'quoted_by', 'published_as', 'listed_as', 'proposed_as', 'produced_by', 'made_with'));
--> statement-breakpoint
-- ── Hand-written below: what the schema files can't express ─────────────
-- The payment ledger is append-only, like the card history (ops_reject_mutation, from 0001_restore_guards).
DROP TRIGGER IF EXISTS "board_card_payments_append_only" ON "board_card_payments";
--> statement-breakpoint
CREATE TRIGGER "board_card_payments_append_only" BEFORE UPDATE OR DELETE ON "board_card_payments" FOR EACH ROW EXECUTE FUNCTION "ops_reject_mutation"();
