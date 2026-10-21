-- Trash (2026-09-29): Delete moves a card, a prompt, a routine or a project to the Trash instead of losing it.
-- `deleted_at` is only ever set on a row that is already archived, so every read that skips archived rows skips
-- deleted ones too; Restore clears both. A card with money in (`paid_total > 0`) can't be deleted: its payments
-- are the record of money that came in. Card history gains `deleted` / `undeleted`.
ALTER TABLE "board_card_events" DROP CONSTRAINT "board_card_events_kind_check";--> statement-breakpoint
ALTER TABLE "agent_routines" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prompt_prompts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_deleted_check" CHECK ("agent_routines"."deleted_at" is null or "agent_routines"."archived_at" is not null);--> statement-breakpoint
ALTER TABLE "board_card_events" ADD CONSTRAINT "board_card_events_kind_check" CHECK ("board_card_events"."kind" in ('created', 'moved', 'edited', 'priced', 'paid', 'unpaid', 'archived', 'restored', 'deleted', 'undeleted', 'followup_added', 'followup_edited', 'followup_removed', 'payment_recorded', 'payment_voided'));--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_deleted_check" CHECK ("board_cards"."deleted_at" is null or ("board_cards"."archived_at" is not null and "board_cards"."paid_total" = 0));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_check" CHECK ("projects"."deleted_at" is null or "projects"."status" = 'archived');--> statement-breakpoint
ALTER TABLE "prompt_prompts" ADD CONSTRAINT "prompt_prompts_deleted_check" CHECK ("prompt_prompts"."deleted_at" is null or "prompt_prompts"."archived_at" is not null);