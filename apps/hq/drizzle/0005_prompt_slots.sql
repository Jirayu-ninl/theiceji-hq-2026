-- Prompt slots (2026-09-30): a prompt's text is a template. `<HAIR_COLOR>` marks a slot — what the owner calls a
-- variant — whose options (a short key picked by name, the value put into the text) are the prompt's own, the
-- library's (a slot with no prompt, shared by every prompt that writes `<NAME>`), or both. An example keeps the
-- options it was made with. A prompt has ONE text from here on: the extra texts (variants A/B/C …) move into prompts
-- of their own — nothing is dropped, and every shot, card link, job and example keeps pointing at the same row.
ALTER TABLE "prompt_examples" ADD CONSTRAINT "prompt_examples_owner_scope_key" UNIQUE("id","owner_id");--> statement-breakpoint
CREATE TABLE "prompt_example_picks" (
	"owner_id" uuid NOT NULL,
	"example_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_example_picks_pkey" PRIMARY KEY("example_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "prompt_slot_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_slot_options_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "prompt_slot_options_key_check" CHECK (length(btrim("prompt_slot_options"."key")) between 1 and 40),
	CONSTRAINT "prompt_slot_options_value_check" CHECK (length("prompt_slot_options"."value") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "prompt_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"prompt_id" uuid,
	"name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "prompt_slots_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "prompt_slots_name_check" CHECK ("prompt_slots"."name" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
	CONSTRAINT "prompt_slots_note_check" CHECK (length("prompt_slots"."note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "prompt_example_picks" ADD CONSTRAINT "prompt_example_picks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_example_picks" ADD CONSTRAINT "prompt_example_picks_example_fk" FOREIGN KEY ("example_id","owner_id") REFERENCES "public"."prompt_examples"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_example_picks" ADD CONSTRAINT "prompt_example_picks_option_fk" FOREIGN KEY ("option_id","owner_id") REFERENCES "public"."prompt_slot_options"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_slot_options" ADD CONSTRAINT "prompt_slot_options_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_slot_options" ADD CONSTRAINT "prompt_slot_options_slot_fk" FOREIGN KEY ("slot_id","owner_id") REFERENCES "public"."prompt_slots"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_slots" ADD CONSTRAINT "prompt_slots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_slots" ADD CONSTRAINT "prompt_slots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_slots" ADD CONSTRAINT "prompt_slots_prompt_fk" FOREIGN KEY ("prompt_id","owner_id") REFERENCES "public"."prompt_prompts"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_example_picks_option_idx" ON "prompt_example_picks" USING btree ("option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_slot_options_key_key" ON "prompt_slot_options" USING btree ("slot_id",lower("key"));--> statement-breakpoint
CREATE INDEX "prompt_slot_options_slot_idx" ON "prompt_slot_options" USING btree ("slot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_slots_library_key" ON "prompt_slots" USING btree ("owner_id","name") WHERE "prompt_slots"."prompt_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_slots_prompt_key" ON "prompt_slots" USING btree ("prompt_id","name") WHERE "prompt_slots"."prompt_id" is not null;--> statement-breakpoint
-- Split: every text but the default (else the first) becomes a prompt of its own — the same owner, project, medium,
-- intent, collection, tags and archive/trash state, titled "<title> · <label>" — carrying its examples by id. The prompt
-- it left gets a new revision, so an editor open on it asks to read again.
DO $$
DECLARE
  moved record;
  fresh uuid;
BEGIN
  FOR moved IN
    SELECT v.id AS variant_id, v.label AS variant_label, v.created_at AS variant_created_at,
           p.id AS prompt_id, p.created_by, p.owner_id, p.project_id, p.title, p.intent, p.medium, p.collection,
           p.tags, p.archived_at, p.deleted_at
    FROM (
      SELECT pv.id, pv.prompt_id, pv.label, pv.created_at,
             row_number() OVER (PARTITION BY pv.prompt_id ORDER BY pv.is_default DESC, pv.position, pv.label) AS rank
      FROM "prompt_variants" pv
    ) v
    JOIN "prompt_prompts" p ON p.id = v.prompt_id
    WHERE v.rank > 1
    ORDER BY p.id, v.rank
  LOOP
    INSERT INTO "prompt_prompts" ("created_at", "updated_at", "created_by", "owner_id", "project_id", "title", "intent",
                                  "medium", "collection", "tags", "archived_at", "deleted_at")
    VALUES (moved.variant_created_at, now(), moved.created_by, moved.owner_id, moved.project_id,
            left(btrim(moved.title), 157 - length(moved.variant_label)) || ' · ' || moved.variant_label,
            moved.intent, moved.medium, moved.collection, moved.tags, moved.archived_at, moved.deleted_at)
    RETURNING "id" INTO fresh;
    UPDATE "prompt_variants"
      SET "prompt_id" = fresh, "is_default" = true, "label" = 'A', "updated_at" = now()
      WHERE "id" = moved.variant_id;
    UPDATE "prompt_prompts" SET "revision" = "revision" + 1, "updated_at" = now() WHERE "id" = moved.prompt_id;
  END LOOP;
  -- The one text left is the default, labelled A.
  UPDATE "prompt_variants" SET "is_default" = true, "label" = 'A' WHERE NOT "is_default" OR "label" <> 'A';
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_variants_one_key" ON "prompt_variants" USING btree ("prompt_id");
