CREATE TABLE "agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"routine_id" uuid,
	"task_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"accepted_as" jsonb,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"held_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	CONSTRAINT "agent_proposals_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "agent_proposals_kind_check" CHECK ("agent_proposals"."kind" in ('note', 'prompt', 'prompt_variant', 'card', 'shot', 'event', 'experiment')),
	CONSTRAINT "agent_proposals_status_check" CHECK ("agent_proposals"."status" in ('proposed', 'accepted', 'rejected', 'expired')),
	CONSTRAINT "agent_proposals_title_check" CHECK (length(btrim("agent_proposals"."title")) between 1 and 200),
	CONSTRAINT "agent_proposals_rationale_check" CHECK (length("agent_proposals"."rationale") <= 4000),
	CONSTRAINT "agent_proposals_payload_check" CHECK (jsonb_typeof("agent_proposals"."payload") = 'object'),
	CONSTRAINT "agent_proposals_accepted_check" CHECK (("agent_proposals"."status" = 'accepted') = ("agent_proposals"."accepted_as" is not null)),
	CONSTRAINT "agent_proposals_decided_check" CHECK (("agent_proposals"."status" = 'proposed') = ("agent_proposals"."decided_at" is null)),
	CONSTRAINT "agent_proposals_actor_check" CHECK ("agent_proposals"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "agent_routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"playbook" text DEFAULT '' NOT NULL,
	"modules" text[] DEFAULT '{}'::text[] NOT NULL,
	"runner" text DEFAULT 'mcp' NOT NULL,
	"llm_connection_id" uuid,
	"max_turns" integer DEFAULT 20 NOT NULL,
	"auto_accept" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_due_at" timestamp with time zone,
	"last_queued_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "agent_routines_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "agent_routines_name_check" CHECK (length(btrim("agent_routines"."name")) between 1 and 120),
	CONSTRAINT "agent_routines_cron_check" CHECK (length(btrim("agent_routines"."cron")) between 1 and 120),
	CONSTRAINT "agent_routines_timezone_check" CHECK (length(btrim("agent_routines"."timezone")) between 1 and 64),
	CONSTRAINT "agent_routines_playbook_check" CHECK (length("agent_routines"."playbook") <= 50000),
	CONSTRAINT "agent_routines_modules_check" CHECK ("agent_routines"."modules" <@ array['board', 'prompts', 'assets', 'story', 'calendar', 'quotes', 'publish', 'market', 'experiments', 'readings', 'agents', 'notes']::text[]),
	CONSTRAINT "agent_routines_runner_check" CHECK ("agent_routines"."runner" in ('mcp', 'builtin')),
	CONSTRAINT "agent_routines_auto_accept_check" CHECK ("agent_routines"."auto_accept" <@ array['note', 'prompt_variant']::text[]),
	CONSTRAINT "agent_routines_max_turns_check" CHECK ("agent_routines"."max_turns" between 1 and 200),
	CONSTRAINT "agent_routines_due_check" CHECK ("agent_routines"."enabled" or "agent_routines"."next_due_at" is null)
);
--> statement-breakpoint
CREATE TABLE "asset_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text,
	"sha256_note" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"thumb_key" text,
	"origin" text DEFAULT 'upload' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"problem" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"ready_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	CONSTRAINT "asset_assets_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "asset_assets_provider_check" CHECK ("asset_assets"."storage_provider" in ('r2', 'gdrive')),
	CONSTRAINT "asset_assets_kind_check" CHECK ("asset_assets"."kind" in ('image', 'video', 'audio', 'doc', 'other')),
	CONSTRAINT "asset_assets_origin_check" CHECK ("asset_assets"."origin" in ('upload', 'generated', 'import')),
	CONSTRAINT "asset_assets_status_check" CHECK ("asset_assets"."status" in ('pending', 'ready', 'rejected')),
	CONSTRAINT "asset_assets_actor_check" CHECK ("asset_assets"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "asset_assets_name_check" CHECK (length(btrim("asset_assets"."name")) between 1 and 240),
	CONSTRAINT "asset_assets_path_check" CHECK (length("asset_assets"."path") between 1 and 600),
	CONSTRAINT "asset_assets_bytes_check" CHECK ("asset_assets"."bytes" >= 0),
	CONSTRAINT "asset_assets_sha_check" CHECK ("asset_assets"."sha256" is null or "asset_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_assets_ready_check" CHECK (("asset_assets"."status" = 'ready') = ("asset_assets"."ready_at" is not null) or "asset_assets"."status" = 'rejected'),
	CONSTRAINT "asset_assets_tags_check" CHECK (cardinality("asset_assets"."tags") <= 24)
);
--> statement-breakpoint
CREATE TABLE "asset_collection_items" (
	"owner_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_collection_items_pkey" PRIMARY KEY("collection_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "asset_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "asset_collections_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "asset_collections_kind_check" CHECK ("asset_collections"."kind" in ('characters', 'scenes', 'refs', 'generated', 'custom')),
	CONSTRAINT "asset_collections_name_check" CHECK (length(btrim("asset_collections"."name")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "asset_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"title" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"target_role" text,
	"variant_id" uuid,
	"task_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"remote_id" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	CONSTRAINT "asset_generation_jobs_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "asset_generation_jobs_provider_check" CHECK ("asset_generation_jobs"."provider" ~ '^(manual|local_worker|agent:[a-z0-9_.-]{1,60}|external:[a-z0-9_.-]{1,60})$'),
	CONSTRAINT "asset_generation_jobs_operation_check" CHECK ("asset_generation_jobs"."operation" in ('generate', 'thumbnail', 'zip', 'compose', 'render', 'package', 'mockup', 'probe')),
	CONSTRAINT "asset_generation_jobs_status_check" CHECK ("asset_generation_jobs"."status" in ('awaiting_upload', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "asset_generation_jobs_target_type_check" CHECK ("asset_generation_jobs"."target_type" is null or "asset_generation_jobs"."target_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request')),
	CONSTRAINT "asset_generation_jobs_target_role_check" CHECK ("asset_generation_jobs"."target_role" is null or "asset_generation_jobs"."target_role" in ('promoted_to', 'attached', 'example_of', 'result_of', 'scheduled_as', 'quoted_by', 'published_as', 'listed_as', 'proposed_as', 'produced_by')),
	CONSTRAINT "asset_generation_jobs_target_check" CHECK (("asset_generation_jobs"."target_type" is null) = ("asset_generation_jobs"."target_id" is null) and ("asset_generation_jobs"."target_type" is null) = ("asset_generation_jobs"."target_role" is null)),
	CONSTRAINT "asset_generation_jobs_title_check" CHECK (length(btrim("asset_generation_jobs"."title")) between 1 and 200),
	CONSTRAINT "asset_generation_jobs_input_check" CHECK (jsonb_typeof("asset_generation_jobs"."input") = 'object'),
	CONSTRAINT "asset_generation_jobs_done_check" CHECK ("asset_generation_jobs"."status" <> 'succeeded' or cardinality("asset_generation_jobs"."result_asset_ids") > 0),
	CONSTRAINT "asset_generation_jobs_manual_check" CHECK (("asset_generation_jobs"."status" = 'awaiting_upload') <= ("asset_generation_jobs"."provider" = 'manual')),
	CONSTRAINT "asset_generation_jobs_actor_check" CHECK ("asset_generation_jobs"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"auth_method" text DEFAULT 'none' NOT NULL,
	"secret_hash" text,
	CONSTRAINT "oauth_clients_kind_check" CHECK ("oauth_clients"."kind" in ('dcr', 'cimd')),
	CONSTRAINT "oauth_clients_auth_method_check" CHECK ("oauth_clients"."auth_method" in ('none', 'client_secret_post', 'client_secret_basic'))
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"used_at" timestamp with time zone,
	"grant_id" uuid
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"client_id" text,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"actor_type" text DEFAULT 'agent' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_grants_kind_check" CHECK ("oauth_grants"."kind" in ('oauth', 'personal')),
	CONSTRAINT "oauth_grants_actor_type_check" CHECK ("oauth_grants"."actor_type" in ('agent', 'worker')),
	CONSTRAINT "oauth_grants_client_check" CHECK (("oauth_grants"."kind" = 'oauth') = ("oauth_grants"."client_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"hint" text,
	CONSTRAINT "oauth_tokens_kind_check" CHECK ("oauth_tokens"."kind" in ('access', 'refresh', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'editor'))
);
--> statement-breakpoint
CREATE TABLE "board_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"preset" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "board_boards_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "board_boards_name_check" CHECK (length(btrim("board_boards"."name")) between 1 and 120),
	CONSTRAINT "board_boards_preset_check" CHECK ("board_boards"."preset" is null or "board_boards"."preset" in ('channel', 'digital_assets', 'film', 'freelance', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "board_card_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"from_lane_id" uuid,
	"to_lane_id" uuid,
	"amount" numeric(12, 2),
	"currency" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_card_events_kind_check" CHECK ("board_card_events"."kind" in ('created', 'moved', 'edited', 'priced', 'paid', 'unpaid', 'archived', 'restored')),
	CONSTRAINT "board_card_events_actor_check" CHECK ("board_card_events"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "board_card_events_currency_check" CHECK ("board_card_events"."currency" is null or "board_card_events"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "board_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"lane_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"price" numeric(12, 2),
	"currency" text,
	"due_on" date,
	"client" text,
	"position" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "board_cards_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "board_cards_title_check" CHECK (length(btrim("board_cards"."title")) between 1 and 200),
	CONSTRAINT "board_cards_body_check" CHECK (length("board_cards"."body") <= 20000),
	CONSTRAINT "board_cards_price_check" CHECK ("board_cards"."price" is null or ("board_cards"."price" >= 0 and "board_cards"."currency" is not null)),
	CONSTRAINT "board_cards_currency_check" CHECK ("board_cards"."currency" is null or "board_cards"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "board_cards_client_check" CHECK ("board_cards"."client" is null or length(btrim("board_cards"."client")) between 1 and 120),
	CONSTRAINT "board_cards_labels_check" CHECK (cardinality("board_cards"."labels") <= 12),
	CONSTRAINT "board_cards_paid_check" CHECK ("board_cards"."paid_at" is null or "board_cards"."archived_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "board_lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"role" text DEFAULT 'normal' NOT NULL,
	"wip_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_lanes_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "board_lanes_board_scope_key" UNIQUE("id","board_id"),
	CONSTRAINT "board_lanes_name_check" CHECK (length(btrim("board_lanes"."name")) between 1 and 60),
	CONSTRAINT "board_lanes_role_check" CHECK ("board_lanes"."role" in ('normal', 'awaiting_payment', 'done')),
	CONSTRAINT "board_lanes_wip_check" CHECK ("board_lanes"."wip_limit" is null or "board_lanes"."wip_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"timezone" text,
	"source" text DEFAULT 'hq' NOT NULL,
	"sync" boolean DEFAULT false NOT NULL,
	"sync_state" text DEFAULT 'local' NOT NULL,
	"sync_problem" text,
	"google_calendar_id" text,
	"google_event_id" text,
	"google_etag" text,
	"google_updated_at" timestamp with time zone,
	"google_html_link" text,
	"synced_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "calendar_events_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "calendar_events_title_check" CHECK (length(btrim("calendar_events"."title")) between 1 and 200),
	CONSTRAINT "calendar_events_description_check" CHECK (length("calendar_events"."description") <= 8000),
	CONSTRAINT "calendar_events_source_check" CHECK ("calendar_events"."source" in ('hq', 'google')),
	CONSTRAINT "calendar_events_sync_state_check" CHECK ("calendar_events"."sync_state" in ('local', 'pending', 'synced', 'error')),
	CONSTRAINT "calendar_events_range_check" CHECK ("calendar_events"."ends_at" >= "calendar_events"."starts_at"),
	CONSTRAINT "calendar_events_all_day_check" CHECK (not "calendar_events"."all_day" or ("calendar_events"."starts_at" = date_trunc('day', "calendar_events"."starts_at" at time zone 'UTC') at time zone 'UTC' and "calendar_events"."ends_at" > "calendar_events"."starts_at")),
	CONSTRAINT "calendar_events_google_check" CHECK ("calendar_events"."source" <> 'google' or "calendar_events"."google_event_id" is not null),
	CONSTRAINT "calendar_events_local_check" CHECK ("calendar_events"."sync" or "calendar_events"."sync_state" = 'local' or "calendar_events"."google_event_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_state" (
	"owner_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"sync_token" text,
	"last_synced_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"problem" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_sync_state_pkey" PRIMARY KEY("owner_id","calendar_id")
);
--> statement-breakpoint
CREATE TABLE "google_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"refresh_token_sealed" text,
	"drive_root_id" text,
	"calendar_id" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"problem" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_connections_status_check" CHECK ("google_connections"."status" in ('connected', 'needs_reauth', 'revoked')),
	CONSTRAINT "google_connections_token_check" CHECK ("google_connections"."status" <> 'connected' or "google_connections"."refresh_token_sealed" is not null),
	CONSTRAINT "google_connections_revoked_check" CHECK (("google_connections"."status" = 'revoked') = ("google_connections"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "owner_settings" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"storage_provider" text DEFAULT 'r2' NOT NULL,
	"storage_root" text,
	"quote_issuer" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_settings_storage_check" CHECK ("owner_settings"."storage_provider" in ('r2', 'gdrive')),
	CONSTRAINT "owner_settings_issuer_check" CHECK ("owner_settings"."quote_issuer" is null or jsonb_typeof("owner_settings"."quote_issuer") = 'object')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"color" text DEFAULT 'grey' NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"modules" jsonb DEFAULT '{"enabled":[],"settings":{}}'::jsonb NOT NULL,
	"storage_provider" text,
	"storage_root" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "projects_kind_check" CHECK ("projects"."kind" in ('channel', 'digital_assets', 'film', 'freelance', 'personal')),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('active', 'paused', 'archived')),
	CONSTRAINT "projects_color_check" CHECK ("projects"."color" in ('violet', 'teal', 'blue', 'pink', 'grey', 'orange', 'mint', 'gold', 'lavender', 'sky')),
	CONSTRAINT "projects_storage_check" CHECK ("projects"."storage_provider" is null or "projects"."storage_provider" in ('r2', 'gdrive')),
	CONSTRAINT "projects_slug_check" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("projects"."slug") <= 64),
	CONSTRAINT "projects_name_check" CHECK (length(btrim("projects"."name")) between 1 and 120),
	CONSTRAINT "projects_currency_check" CHECK ("projects"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "projects_modules_check" CHECK (jsonb_typeof("projects"."modules" -> 'enabled') = 'array' and jsonb_typeof("projects"."modules" -> 'settings') = 'object'),
	CONSTRAINT "projects_archived_check" CHECK (("projects"."status" = 'archived') = ("projects"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_sealed" text,
	"secret_hint" text,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"problem" text,
	"last_checked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_connections_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "provider_connections_provider_check" CHECK ("provider_connections"."provider" in ('openai_compatible', 'facebook', 'youtube', 'tiktok', 'etsy', 'llm:anthropic', 'llm:openai_compatible')),
	CONSTRAINT "provider_connections_status_check" CHECK ("provider_connections"."status" in ('not_connected', 'connected', 'needs_reauth', 'error', 'revoked')),
	CONSTRAINT "provider_connections_connected_check" CHECK ("provider_connections"."status" <> 'connected' or "provider_connections"."secret_sealed" is not null),
	CONSTRAINT "provider_connections_revoked_check" CHECK (("provider_connections"."status" = 'revoked') = ("provider_connections"."revoked_at" is not null)),
	CONSTRAINT "provider_connections_label_check" CHECK (length(btrim("provider_connections"."label")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refs_from_type_check" CHECK ("refs"."from_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request')),
	CONSTRAINT "refs_to_type_check" CHECK ("refs"."to_type" in ('note', 'prompt', 'prompt_variant', 'card', 'asset', 'shot', 'event', 'quote', 'post', 'listing', 'experiment', 'proposal', 'task', 'human_request')),
	CONSTRAINT "refs_role_check" CHECK ("refs"."role" in ('promoted_to', 'attached', 'example_of', 'result_of', 'scheduled_as', 'quoted_by', 'published_as', 'listed_as', 'proposed_as', 'produced_by')),
	CONSTRAINT "refs_self_check" CHECK (not ("refs"."from_type" = "refs"."to_type" and "refs"."from_id" = "refs"."to_id"))
);
--> statement-breakpoint
CREATE TABLE "exp_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"winner_variant_id" uuid,
	"rationale" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exp_decisions_verdict_check" CHECK ("exp_decisions"."verdict" in ('winner', 'no_difference', 'inconclusive', 'stopped')),
	CONSTRAINT "exp_decisions_winner_check" CHECK (("exp_decisions"."verdict" = 'winner') = ("exp_decisions"."winner_variant_id" is not null)),
	CONSTRAINT "exp_decisions_rationale_check" CHECK (length(btrim("exp_decisions"."rationale")) between 1 and 4000),
	CONSTRAINT "exp_decisions_actor_check" CHECK ("exp_decisions"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "exp_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"question" text NOT NULL,
	"hypothesis" text DEFAULT '' NOT NULL,
	"subject_type" text NOT NULL,
	"metric" text NOT NULL,
	"read_at_hours" integer DEFAULT 72 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "exp_experiments_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "exp_experiments_status_check" CHECK ("exp_experiments"."status" in ('draft', 'running', 'reading', 'decided', 'archived')),
	CONSTRAINT "exp_experiments_subject_check" CHECK ("exp_experiments"."subject_type" in ('post', 'listing')),
	CONSTRAINT "exp_experiments_question_check" CHECK (length(btrim("exp_experiments"."question")) between 1 and 400),
	CONSTRAINT "exp_experiments_hypothesis_check" CHECK (length("exp_experiments"."hypothesis") <= 4000),
	CONSTRAINT "exp_experiments_metric_check" CHECK ("exp_experiments"."metric" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "exp_experiments_age_check" CHECK ("exp_experiments"."read_at_hours" between 1 and 8760),
	CONSTRAINT "exp_experiments_started_check" CHECK ("exp_experiments"."status" = 'draft' or "exp_experiments"."started_at" is not null),
	CONSTRAINT "exp_experiments_decided_check" CHECK ("exp_experiments"."status" <> 'decided' or "exp_experiments"."decided_at" is not null),
	CONSTRAINT "exp_experiments_archived_check" CHECK (("exp_experiments"."status" = 'archived') = ("exp_experiments"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "exp_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exp_items_subject_type_check" CHECK ("exp_items"."subject_type" in ('post', 'listing')),
	CONSTRAINT "exp_items_actor_check" CHECK ("exp_items"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "exp_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"experiment_id" uuid,
	"statement" text NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "exp_learnings_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "exp_learnings_status_check" CHECK ("exp_learnings"."status" in ('active', 'retired')),
	CONSTRAINT "exp_learnings_statement_check" CHECK (length(btrim("exp_learnings"."statement")) between 1 and 1000),
	CONSTRAINT "exp_learnings_evidence_check" CHECK (length("exp_learnings"."evidence") <= 4000),
	CONSTRAINT "exp_learnings_tags_check" CHECK (cardinality("exp_learnings"."tags") <= 12),
	CONSTRAINT "exp_learnings_retired_check" CHECK (("exp_learnings"."status" = 'retired') = ("exp_learnings"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "exp_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exp_variants_experiment_scope_key" UNIQUE("id","experiment_id"),
	CONSTRAINT "exp_variants_label_check" CHECK (length(btrim("exp_variants"."label")) between 1 and 40),
	CONSTRAINT "exp_variants_description_check" CHECK (length("exp_variants"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "market_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"remote_listing_id" text,
	"remote_url" text,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	CONSTRAINT "market_intents_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_intents_status_check" CHECK ("market_intents"."status" in ('submitting', 'submitted', 'unknown', 'verified', 'failed', 'cancelled')),
	CONSTRAINT "market_intents_kind_check" CHECK ("market_intents"."kind" in ('etsy', 'pod', 'gumroad', 'manual')),
	CONSTRAINT "market_intents_actor_check" CHECK ("market_intents"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "market_intents_verified_check" CHECK ("market_intents"."status" <> 'verified' or ("market_intents"."verified_at" is not null and ("market_intents"."remote_listing_id" is not null or "market_intents"."remote_url" is not null)))
);
--> statement-breakpoint
CREATE TABLE "market_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"listed_at" timestamp with time zone,
	"external_id" text,
	"url" text,
	"evidence_level" text,
	"evidence_note" text,
	"inactive_at" timestamp with time zone,
	"status_reason" text,
	CONSTRAINT "market_listings_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_listings_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "market_listings_status_check" CHECK ("market_listings"."status" in ('planned', 'approved', 'dispatched', 'listed', 'verified', 'inactive', 'failed')),
	CONSTRAINT "market_listings_evidence_level_check" CHECK ("market_listings"."evidence_level" is null or "market_listings"."evidence_level" in ('owner_attested', 'agent_attested', 'screenshot', 'platform_export', 'provider_verified')),
	CONSTRAINT "market_listings_title_check" CHECK (length(btrim("market_listings"."title")) between 1 and 200),
	CONSTRAINT "market_listings_description_check" CHECK (length("market_listings"."description") <= 20000),
	CONSTRAINT "market_listings_price_check" CHECK ("market_listings"."price" >= 0),
	CONSTRAINT "market_listings_currency_check" CHECK ("market_listings"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_listings_tags_check" CHECK (cardinality("market_listings"."tags") <= 13),
	CONSTRAINT "market_listings_url_check" CHECK ("market_listings"."url" is null or "market_listings"."url" ~ '^https?://' and length("market_listings"."url") <= 600),
	CONSTRAINT "market_listings_evidence_check" CHECK ("market_listings"."status" not in ('listed', 'verified') or ("market_listings"."listed_at" is not null and "market_listings"."evidence_level" is not null and ("market_listings"."url" is not null or "market_listings"."external_id" is not null))),
	CONSTRAINT "market_listings_verified_check" CHECK ("market_listings"."status" <> 'verified' or "market_listings"."evidence_level" = 'provider_verified'),
	CONSTRAINT "market_listings_inactive_check" CHECK (("market_listings"."status" = 'inactive') = ("market_listings"."inactive_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "market_marketplaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"shop" text NOT NULL,
	"url" text,
	"connection_id" uuid,
	"external_shop_id" text,
	"currency" text NOT NULL,
	"fee_sheet" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone,
	"sync_problem" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "market_marketplaces_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_marketplaces_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "market_marketplaces_kind_check" CHECK ("market_marketplaces"."kind" in ('etsy', 'pod', 'gumroad', 'manual')),
	CONSTRAINT "market_marketplaces_shop_check" CHECK (length(btrim("market_marketplaces"."shop")) between 1 and 120),
	CONSTRAINT "market_marketplaces_currency_check" CHECK ("market_marketplaces"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_marketplaces_url_check" CHECK ("market_marketplaces"."url" is null or "market_marketplaces"."url" ~ '^https?://' and length("market_marketplaces"."url") <= 600),
	CONSTRAINT "market_marketplaces_fee_check" CHECK (jsonb_typeof("market_marketplaces"."fee_sheet") = 'object'),
	CONSTRAINT "market_marketplaces_settings_check" CHECK (jsonb_typeof("market_marketplaces"."settings") = 'object')
);
--> statement-breakpoint
CREATE TABLE "market_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"expected_on" date,
	"paid_on" date,
	"reference" text,
	"note" text,
	CONSTRAINT "market_payouts_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_payouts_status_check" CHECK ("market_payouts"."status" in ('expected', 'confirmed')),
	CONSTRAINT "market_payouts_amount_check" CHECK ("market_payouts"."amount" >= 0),
	CONSTRAINT "market_payouts_currency_check" CHECK ("market_payouts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_payouts_paid_check" CHECK (("market_payouts"."status" = 'confirmed') = ("market_payouts"."paid_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "market_product_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"role" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_product_files_role_check" CHECK ("market_product_files"."role" in ('deliverable', 'preview'))
);
--> statement-breakpoint
CREATE TABLE "market_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"price" numeric(12, 2),
	"currency" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "market_products_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_products_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "market_products_status_check" CHECK ("market_products"."status" in ('draft', 'ready', 'retired')),
	CONSTRAINT "market_products_title_check" CHECK (length(btrim("market_products"."title")) between 1 and 200),
	CONSTRAINT "market_products_description_check" CHECK (length("market_products"."description") <= 20000),
	CONSTRAINT "market_products_price_check" CHECK ("market_products"."price" is null or ("market_products"."price" >= 0 and "market_products"."currency" is not null)),
	CONSTRAINT "market_products_currency_check" CHECK ("market_products"."currency" is null or "market_products"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_products_tags_check" CHECK (cardinality("market_products"."tags") <= 13)
);
--> statement-breakpoint
CREATE TABLE "market_sales_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"listing_id" uuid,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"gross" numeric(12, 2) NOT NULL,
	"fees" numeric(12, 2) NOT NULL,
	"net" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"order_ref" text,
	"source" text NOT NULL,
	"note" text,
	"supersedes_id" uuid,
	"correction_reason" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_sales_events_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "market_sales_events_kind_check" CHECK ("market_sales_events"."kind" in ('sale', 'refund', 'fee', 'adjustment')),
	CONSTRAINT "market_sales_events_currency_check" CHECK ("market_sales_events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_sales_events_quantity_check" CHECK ("market_sales_events"."quantity" >= 0),
	CONSTRAINT "market_sales_events_fees_check" CHECK ("market_sales_events"."fees" >= 0),
	CONSTRAINT "market_sales_events_net_check" CHECK ("market_sales_events"."net" = "market_sales_events"."gross" - "market_sales_events"."fees"),
	CONSTRAINT "market_sales_events_source_check" CHECK ("market_sales_events"."source" in ('manual', 'agent', 'provider', 'import')),
	CONSTRAINT "market_sales_events_actor_check" CHECK ("market_sales_events"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "market_sales_events_correction_check" CHECK ("market_sales_events"."supersedes_id" is null or "market_sales_events"."correction_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text,
	"body" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'none' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"promoted_to" jsonb,
	"project_id" uuid,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_color_check" CHECK ("notes"."color" in ('none', 'citron', 'sage', 'sky', 'lilac', 'blush', 'sand', 'clay'))
);
--> statement-breakpoint
CREATE TABLE "ops_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"fencing_token" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpoint_seq" integer DEFAULT 0 NOT NULL,
	"last_checkpoint" jsonb,
	"next_action" text,
	"budgets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_agent_runs_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_agent_runs_actor_check" CHECK ("ops_agent_runs"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "ops_agent_runs_status_check" CHECK ("ops_agent_runs"."status" in ('running', 'succeeded', 'failed', 'abandoned', 'cancelled')),
	CONSTRAINT "ops_agent_runs_ended_check" CHECK (("ops_agent_runs"."status" = 'running') = ("ops_agent_runs"."ended_at" is null))
);
--> statement-breakpoint
CREATE TABLE "ops_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"project_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"before_revision" integer,
	"after_revision" integer,
	"reason" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ops_audit_events_actor_check" CHECK ("ops_audit_events"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "ops_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"policy_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"amount" bigint NOT NULL,
	"settled_amount" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"provider" text,
	"purpose" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_budget_reservations_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_budget_reservations_kind_check" CHECK ("ops_budget_reservations"."kind" in ('cash', 'credits', 'quota')),
	CONSTRAINT "ops_budget_reservations_status_check" CHECK ("ops_budget_reservations"."status" in ('reserved', 'settled', 'released', 'expired')),
	CONSTRAINT "ops_budget_reservations_actor_check" CHECK ("ops_budget_reservations"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "ops_budget_reservations_amount_check" CHECK ("ops_budget_reservations"."amount" >= 0 and coalesce("ops_budget_reservations"."settled_amount", 0) >= 0),
	CONSTRAINT "ops_budget_reservations_settled_check" CHECK (("ops_budget_reservations"."status" = 'settled') = ("ops_budget_reservations"."settled_at" is not null and "ops_budget_reservations"."settled_amount" is not null))
);
--> statement-breakpoint
CREATE TABLE "ops_capability_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"target_ref" text,
	"capability" text NOT NULL,
	"state" text NOT NULL,
	"evidence" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_capability_checks_state_check" CHECK ("ops_capability_checks"."state" in ('declared', 'tested', 'unavailable')),
	CONSTRAINT "ops_capability_checks_expiry_check" CHECK ("ops_capability_checks"."expires_at" is null or "ops_capability_checks"."expires_at" > "ops_capability_checks"."checked_at"),
	CONSTRAINT "ops_capability_checks_actor_check" CHECK ("ops_capability_checks"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "ops_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_event_deliveries_status_check" CHECK ("ops_event_deliveries"."status" in ('pending', 'delivered', 'acknowledged', 'dead_letter', 'cancelled')),
	CONSTRAINT "ops_event_deliveries_attempts_check" CHECK ("ops_event_deliveries"."attempts" >= 0 and "ops_event_deliveries"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ops_human_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"module" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"requested_action" jsonb NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"target_revision" integer,
	"impact" text,
	"meanwhile" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"urgency" text DEFAULT 'digest' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dedupe_key" text,
	"task_id" uuid,
	"answered_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	CONSTRAINT "ops_human_requests_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_human_requests_kind_check" CHECK ("ops_human_requests"."kind" in ('approval', 'choice', 'sign_in', 'consent', 'identity', 'payout', 'likeness', 'spend_scope', 'account_dispute', 'manual_step', 'information')),
	CONSTRAINT "ops_human_requests_module_check" CHECK ("ops_human_requests"."module" is null or "ops_human_requests"."module" in ('board', 'prompts', 'assets', 'story', 'calendar', 'quotes', 'publish', 'market', 'experiments', 'readings', 'agents', 'notes')),
	CONSTRAINT "ops_human_requests_status_check" CHECK ("ops_human_requests"."status" in ('open', 'answered', 'expired', 'withdrawn')),
	CONSTRAINT "ops_human_requests_urgency_check" CHECK ("ops_human_requests"."urgency" in ('digest', 'urgent')),
	CONSTRAINT "ops_human_requests_answered_check" CHECK (("ops_human_requests"."status" = 'answered') = ("ops_human_requests"."answered_at" is not null)),
	CONSTRAINT "ops_human_requests_actor_check" CHECK ("ops_human_requests"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "ops_human_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"request_id" uuid NOT NULL,
	"request_revision" integer NOT NULL,
	"choice" text NOT NULL,
	"note" text,
	"responded_by" uuid NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"project_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"audit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ops_idempotency_keys_state_check" CHECK ("ops_idempotency_keys"."state" in ('committed', 'completed')),
	CONSTRAINT "ops_idempotency_keys_length_check" CHECK (length("ops_idempotency_keys"."key") between 8 and 200)
);
--> statement-breakpoint
CREATE TABLE "ops_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"project_id" uuid,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"task_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_inbound_events_status_check" CHECK ("ops_inbound_events"."status" in ('accepted', 'rejected', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE "ops_kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"scope" text NOT NULL,
	"target" text,
	"reason" text NOT NULL,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"engaged_by" uuid NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	CONSTRAINT "ops_kill_switches_scope_check" CHECK ("ops_kill_switches"."scope" in ('all', 'project', 'provider', 'connection', 'account', 'marketplace')),
	CONSTRAINT "ops_kill_switches_target_check" CHECK (case "ops_kill_switches"."scope"
        when 'all' then "ops_kill_switches"."project_id" is null and "ops_kill_switches"."target" is null
        when 'project' then "ops_kill_switches"."project_id" is not null and "ops_kill_switches"."target" is null
        else "ops_kill_switches"."target" is not null
      end),
	CONSTRAINT "ops_kill_switches_release_check" CHECK (("ops_kill_switches"."released_at" is null) = ("ops_kill_switches"."released_by" is null) and ("ops_kill_switches"."released_at" is null or "ops_kill_switches"."release_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "ops_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_outbox_events_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_outbox_events_type_check" CHECK ("ops_outbox_events"."type" in ('task.ready', 'job.finished', 'human.responded', 'proposal.decided', 'run.stalled', 'publication.changed', 'listing.changed', 'order.received', 'sync.failed', 'budget.warning')),
	CONSTRAINT "ops_outbox_events_status_check" CHECK ("ops_outbox_events"."status" in ('pending', 'delivered', 'acknowledged', 'dead_letter', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "ops_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"revision_no" integer NOT NULL,
	"supersedes_id" uuid,
	"status" text NOT NULL,
	"release_mode" text DEFAULT 'human_required' NOT NULL,
	"coverage" text DEFAULT 'all_connections' NOT NULL,
	"grant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" text NOT NULL,
	"cash_limit_per_job_minor" bigint,
	"cash_limit_per_day_minor" bigint,
	"cash_limit_per_month_minor" bigint,
	"unit_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_concurrent_jobs" integer DEFAULT 1 NOT NULL,
	"max_posts_per_account_per_day" integer DEFAULT 0 NOT NULL,
	"post_cooldown_minutes" integer DEFAULT 0 NOT NULL,
	"wip_limit" integer,
	"operator_minutes_per_week" integer,
	"stop_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_policies_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_policies_status_check" CHECK ("ops_policies"."status" in ('active', 'suspended')),
	CONSTRAINT "ops_policies_release_check" CHECK ("ops_policies"."release_mode" in ('human_required', 'policy_gated')),
	CONSTRAINT "ops_policies_coverage_check" CHECK ("ops_policies"."coverage" in ('all_connections', 'selected')),
	CONSTRAINT "ops_policies_revision_check" CHECK ("ops_policies"."revision_no" >= 1 and ("ops_policies"."revision_no" = 1) = ("ops_policies"."supersedes_id" is null)),
	CONSTRAINT "ops_policies_currency_check" CHECK ("ops_policies"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ops_policies_limits_check" CHECK (coalesce("ops_policies"."cash_limit_per_job_minor", 0) >= 0 and coalesce("ops_policies"."cash_limit_per_day_minor", 0) >= 0 and coalesce("ops_policies"."cash_limit_per_month_minor", 0) >= 0 and "ops_policies"."max_concurrent_jobs" >= 0 and "ops_policies"."max_posts_per_account_per_day" >= 0 and "ops_policies"."post_cooldown_minutes" >= 0 and coalesce("ops_policies"."wip_limit", 0) >= 0 and coalesce("ops_policies"."operator_minutes_per_week", 0) >= 0),
	CONSTRAINT "ops_policies_period_check" CHECK ("ops_policies"."expires_at" is null or "ops_policies"."expires_at" > "ops_policies"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "ops_release_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"module" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"asset_id" uuid,
	"asset_sha256" text,
	"target_ref" text,
	"mode" text NOT NULL,
	"policy_id" uuid,
	"approved_by" uuid,
	"quality_check_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"status_reason" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_release_authorizations_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_release_authorizations_module_check" CHECK ("ops_release_authorizations"."module" in ('board', 'prompts', 'assets', 'story', 'calendar', 'quotes', 'publish', 'market', 'experiments', 'readings', 'agents', 'notes')),
	CONSTRAINT "ops_release_authorizations_mode_check" CHECK ("ops_release_authorizations"."mode" in ('human_approval', 'policy_gated')),
	CONSTRAINT "ops_release_authorizations_status_check" CHECK ("ops_release_authorizations"."status" in ('active', 'consumed', 'revoked', 'expired')),
	CONSTRAINT "ops_release_authorizations_basis_check" CHECK (case "ops_release_authorizations"."mode"
        when 'human_approval' then "ops_release_authorizations"."approved_by" is not null
        else "ops_release_authorizations"."policy_id" is not null and "ops_release_authorizations"."approved_by" is null
      end),
	CONSTRAINT "ops_release_authorizations_asset_check" CHECK (("ops_release_authorizations"."asset_id" is null) = ("ops_release_authorizations"."asset_sha256" is null)),
	CONSTRAINT "ops_release_authorizations_state_check" CHECK (("ops_release_authorizations"."status" = 'consumed') = ("ops_release_authorizations"."consumed_at" is not null) and ("ops_release_authorizations"."status" = 'revoked') = ("ops_release_authorizations"."revoked_at" is not null)),
	CONSTRAINT "ops_release_authorizations_actor_check" CHECK ("ops_release_authorizations"."actor_type" in ('user', 'agent', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "ops_run_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"summary" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_run_checkpoints_seq_key" UNIQUE("run_id","seq"),
	CONSTRAINT "ops_run_checkpoints_seq_check" CHECK ("ops_run_checkpoints"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ops_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"delivery_url" text,
	"sealed_delivery_secret" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_wake_at" timestamp with time zone,
	"reported_version" text,
	"stalled_after_seconds" integer DEFAULT 900 NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ops_runtimes_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_runtimes_kind_check" CHECK ("ops_runtimes"."kind" in ('agent', 'worker')),
	CONSTRAINT "ops_runtimes_status_check" CHECK ("ops_runtimes"."status" in ('active', 'paused', 'revoked')),
	CONSTRAINT "ops_runtimes_delivery_check" CHECK (("ops_runtimes"."delivery_url" is null) = ("ops_runtimes"."sealed_delivery_secret" is null)),
	CONSTRAINT "ops_runtimes_numbers_check" CHECK ("ops_runtimes"."stalled_after_seconds" >= 60 and "ops_runtimes"."max_concurrency" >= 1),
	CONSTRAINT "ops_runtimes_revoked_check" CHECK (("ops_runtimes"."status" = 'revoked') = ("ops_runtimes"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ops_scheduler_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ops_scheduler_leases_expiry_check" CHECK ("ops_scheduler_leases"."expires_at" > "ops_scheduler_leases"."acquired_at")
);
--> statement-breakpoint
CREATE TABLE "ops_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"module" text,
	"title" text NOT NULL,
	"detail" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"priority_reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"trigger_key" text,
	"target_type" text,
	"target_id" uuid,
	"claimant" text,
	"lease_actor_type" text,
	"lease_actor_id" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"waiting_on_request_id" uuid,
	"blocked_reason" text,
	"last_error" text,
	"result" jsonb,
	"next_action" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ops_tasks_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "ops_tasks_kind_check" CHECK ("ops_tasks"."kind" in ('routine', 'generation', 'publication', 'listing', 'import', 'reconcile', 'review', 'follow_up', 'other')),
	CONSTRAINT "ops_tasks_module_check" CHECK ("ops_tasks"."module" is null or "ops_tasks"."module" in ('board', 'prompts', 'assets', 'story', 'calendar', 'quotes', 'publish', 'market', 'experiments', 'readings', 'agents', 'notes')),
	CONSTRAINT "ops_tasks_status_check" CHECK ("ops_tasks"."status" in ('open', 'claimed', 'blocked', 'done', 'failed', 'cancelled')),
	CONSTRAINT "ops_tasks_lease_check" CHECK (("ops_tasks"."status" = 'claimed') = ("ops_tasks"."lease_actor_id" is not null and "ops_tasks"."lease_expires_at" is not null and "ops_tasks"."lease_actor_type" is not null)),
	CONSTRAINT "ops_tasks_blocked_check" CHECK ("ops_tasks"."status" <> 'blocked' or "ops_tasks"."blocked_reason" is not null),
	CONSTRAINT "ops_tasks_attempts_check" CHECK ("ops_tasks"."attempts" >= 0 and "ops_tasks"."max_attempts" >= 1 and "ops_tasks"."priority" between 0 and 100),
	CONSTRAINT "ops_tasks_lease_actor_check" CHECK ("ops_tasks"."lease_actor_type" is null or "ops_tasks"."lease_actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "ops_tasks_claimant_check" CHECK ("ops_tasks"."claimant" is null or "ops_tasks"."claimant" in ('worker', 'agent', 'builtin'))
);
--> statement-breakpoint
CREATE TABLE "ops_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"reservation_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" bigint,
	"cost_minor" bigint,
	"currency" text,
	"cost_status" text NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"tokens" bigint,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "ops_usage_events_kind_check" CHECK ("ops_usage_events"."kind" in ('cash', 'credits', 'quota')),
	CONSTRAINT "ops_usage_events_cost_status_check" CHECK ("ops_usage_events"."cost_status" in ('estimated', 'reconciled', 'unknown')),
	CONSTRAINT "ops_usage_events_actor_check" CHECK ("ops_usage_events"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "ops_usage_events_cost_check" CHECK (("ops_usage_events"."cost_status" = 'unknown') = ("ops_usage_events"."cost_minor" is null) and ("ops_usage_events"."cost_minor" is null or ("ops_usage_events"."cost_minor" >= 0 and "ops_usage_events"."currency" ~ '^[A-Z]{3}$'))),
	CONSTRAINT "ops_usage_events_numbers_check" CHECK (coalesce("ops_usage_events"."quantity", 0) >= 0 and coalesce("ops_usage_events"."tokens", 0) >= 0 and "ops_usage_events"."attempt_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "prompt_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"rating" smallint,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_examples_rating_check" CHECK ("prompt_examples"."rating" is null or "prompt_examples"."rating" between 1 and 5),
	CONSTRAINT "prompt_examples_caption_check" CHECK (length("prompt_examples"."caption") <= 300)
);
--> statement-breakpoint
CREATE TABLE "prompt_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"intent" text DEFAULT '' NOT NULL,
	"medium" text NOT NULL,
	"collection" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "prompt_prompts_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "prompt_prompts_title_check" CHECK (length(btrim("prompt_prompts"."title")) between 1 and 160),
	CONSTRAINT "prompt_prompts_intent_check" CHECK (length("prompt_prompts"."intent") <= 2000),
	CONSTRAINT "prompt_prompts_medium_check" CHECK ("prompt_prompts"."medium" in ('image', 'video', 'text', 'audio')),
	CONSTRAINT "prompt_prompts_collection_check" CHECK ("prompt_prompts"."collection" is null or length(btrim("prompt_prompts"."collection")) between 1 and 80),
	CONSTRAINT "prompt_prompts_tags_check" CHECK (cardinality("prompt_prompts"."tags") <= 16)
);
--> statement-breakpoint
CREATE TABLE "prompt_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"label" text NOT NULL,
	"style" text DEFAULT '' NOT NULL,
	"provider_hint" text,
	"model" text,
	"text" text NOT NULL,
	"negative_text" text DEFAULT '' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "prompt_variants_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "prompt_variants_label_check" CHECK (length(btrim("prompt_variants"."label")) between 1 and 24),
	CONSTRAINT "prompt_variants_text_check" CHECK (length("prompt_variants"."text") between 1 and 20000),
	CONSTRAINT "prompt_variants_negative_check" CHECK (length("prompt_variants"."negative_text") <= 4000),
	CONSTRAINT "prompt_variants_style_check" CHECK (length("prompt_variants"."style") <= 200),
	CONSTRAINT "prompt_variants_params_check" CHECK (jsonb_typeof("prompt_variants"."params") = 'object')
);
--> statement-breakpoint
CREATE TABLE "publish_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"profile_url" text,
	"external_account_id" text,
	"connection_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "publish_accounts_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "publish_accounts_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "publish_accounts_platform_check" CHECK ("publish_accounts"."platform" in ('facebook', 'youtube', 'tiktok', 'manual')),
	CONSTRAINT "publish_accounts_handle_check" CHECK (length(btrim("publish_accounts"."handle")) between 1 and 120),
	CONSTRAINT "publish_accounts_url_check" CHECK ("publish_accounts"."profile_url" is null or "publish_accounts"."profile_url" ~ '^https?://' and length("publish_accounts"."profile_url") <= 600),
	CONSTRAINT "publish_accounts_notes_check" CHECK (length("publish_accounts"."notes") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "publish_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"remote_post_id" text,
	"remote_url" text,
	"remote_published_at" timestamp with time zone,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	CONSTRAINT "publish_intents_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "publish_intents_status_check" CHECK ("publish_intents"."status" in ('submitting', 'submitted', 'unknown', 'verified', 'failed', 'cancelled')),
	CONSTRAINT "publish_intents_platform_check" CHECK ("publish_intents"."platform" in ('facebook', 'youtube', 'tiktok', 'manual')),
	CONSTRAINT "publish_intents_actor_check" CHECK ("publish_intents"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "publish_intents_verified_check" CHECK ("publish_intents"."status" <> 'verified' or ("publish_intents"."verified_at" is not null and ("publish_intents"."remote_post_id" is not null or "publish_intents"."remote_url" is not null)))
);
--> statement-breakpoint
CREATE TABLE "publish_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"asset_id" uuid,
	"title" text,
	"caption" text DEFAULT '' NOT NULL,
	"disclosure" jsonb DEFAULT '{"aiGenerated":false,"affiliate":false}'::jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"external_id" text,
	"url" text,
	"evidence_level" text,
	"evidence_note" text,
	"removed_at" timestamp with time zone,
	"status_reason" text,
	CONSTRAINT "publish_posts_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "publish_posts_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "publish_posts_status_check" CHECK ("publish_posts"."status" in ('planned', 'scheduled', 'dispatched', 'posted', 'verified', 'removed', 'failed')),
	CONSTRAINT "publish_posts_evidence_level_check" CHECK ("publish_posts"."evidence_level" is null or "publish_posts"."evidence_level" in ('owner_attested', 'agent_attested', 'screenshot', 'platform_export', 'provider_verified')),
	CONSTRAINT "publish_posts_title_check" CHECK ("publish_posts"."title" is null or length(btrim("publish_posts"."title")) between 1 and 200),
	CONSTRAINT "publish_posts_caption_check" CHECK (length("publish_posts"."caption") <= 5000),
	CONSTRAINT "publish_posts_url_check" CHECK ("publish_posts"."url" is null or "publish_posts"."url" ~ '^https?://' and length("publish_posts"."url") <= 600),
	CONSTRAINT "publish_posts_disclosure_check" CHECK (jsonb_typeof("publish_posts"."disclosure" -> 'aiGenerated') = 'boolean' and jsonb_typeof("publish_posts"."disclosure" -> 'affiliate') = 'boolean'),
	CONSTRAINT "publish_posts_evidence_check" CHECK ("publish_posts"."status" not in ('posted', 'verified', 'removed') or ("publish_posts"."posted_at" is not null and "publish_posts"."evidence_level" is not null and ("publish_posts"."url" is not null or "publish_posts"."external_id" is not null))),
	CONSTRAINT "publish_posts_verified_check" CHECK ("publish_posts"."status" <> 'verified' or "publish_posts"."evidence_level" = 'provider_verified'),
	CONSTRAINT "publish_posts_removed_check" CHECK (("publish_posts"."status" = 'removed') = ("publish_posts"."removed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "publish_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid,
	"account_id" uuid,
	"metric" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"currency" text,
	"window" text NOT NULL,
	"as_of" timestamp with time zone,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"source" text NOT NULL,
	"note" text,
	"supersedes_id" uuid,
	"correction_reason" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_readings_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "publish_readings_subject_check" CHECK (num_nonnulls("publish_readings"."post_id", "publish_readings"."account_id") = 1),
	CONSTRAINT "publish_readings_metric_check" CHECK ("publish_readings"."metric" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "publish_readings_window_type_check" CHECK ("publish_readings"."window" in ('lifetime', 'interval')),
	CONSTRAINT "publish_readings_window_check" CHECK (("publish_readings"."window" = 'lifetime' and "publish_readings"."as_of" is not null and "publish_readings"."window_start" is null and "publish_readings"."window_end" is null) or ("publish_readings"."window" = 'interval' and "publish_readings"."as_of" is null and "publish_readings"."window_start" is not null and "publish_readings"."window_end" is not null and "publish_readings"."window_end" > "publish_readings"."window_start")),
	CONSTRAINT "publish_readings_money_check" CHECK ("publish_readings"."currency" is null or "publish_readings"."window" = 'interval'),
	CONSTRAINT "publish_readings_currency_check" CHECK ("publish_readings"."currency" is null or "publish_readings"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "publish_readings_source_check" CHECK ("publish_readings"."source" in ('manual', 'agent', 'provider', 'import')),
	CONSTRAINT "publish_readings_actor_check" CHECK ("publish_readings"."actor_type" in ('user', 'agent', 'worker')),
	CONSTRAINT "publish_readings_correction_check" CHECK ("publish_readings"."supersedes_id" is null or "publish_readings"."correction_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "quote_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"address" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "quote_clients_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "quote_clients_name_check" CHECK (length(btrim("quote_clients"."name")) between 1 and 160),
	CONSTRAINT "quote_clients_address_check" CHECK (length("quote_clients"."address") <= 600),
	CONSTRAINT "quote_clients_tax_check" CHECK ("quote_clients"."tax_id" is null or length(btrim("quote_clients"."tax_id")) between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"description" text NOT NULL,
	"qty" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quote_lines_description_check" CHECK (length(btrim("quote_lines"."description")) between 1 and 600),
	CONSTRAINT "quote_lines_qty_check" CHECK ("quote_lines"."qty" > 0),
	CONSTRAINT "quote_lines_price_check" CHECK ("quote_lines"."unit_price" >= 0),
	CONSTRAINT "quote_lines_unit_check" CHECK (length("quote_lines"."unit") <= 24)
);
--> statement-breakpoint
CREATE TABLE "quote_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"client_id" uuid,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"issued_on" date,
	"valid_days" integer DEFAULT 30 NOT NULL,
	"valid_until" date,
	"vat_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"wht_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"pdf_asset_id" uuid,
	"totals_snapshot" jsonb,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "quote_quotes_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "quote_quotes_status_check" CHECK ("quote_quotes"."status" in ('draft', 'sent', 'accepted', 'declined', 'expired')),
	CONSTRAINT "quote_quotes_number_check" CHECK ("quote_quotes"."number" ~ '^Q-[0-9]{4}-[0-9]{3,}$'),
	CONSTRAINT "quote_quotes_title_check" CHECK (length(btrim("quote_quotes"."title")) between 1 and 200),
	CONSTRAINT "quote_quotes_currency_check" CHECK ("quote_quotes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "quote_quotes_valid_check" CHECK ("quote_quotes"."valid_days" between 1 and 365),
	CONSTRAINT "quote_quotes_pct_check" CHECK ("quote_quotes"."vat_pct" between 0 and 30 and "quote_quotes"."wht_pct" between 0 and 30),
	CONSTRAINT "quote_quotes_notes_check" CHECK (length("quote_quotes"."notes") <= 4000),
	CONSTRAINT "quote_quotes_sent_check" CHECK (("quote_quotes"."status" = 'draft') = ("quote_quotes"."sent_at" is null)),
	CONSTRAINT "quote_quotes_issued_check" CHECK (("quote_quotes"."sent_at" is null) = ("quote_quotes"."issued_on" is null) and ("quote_quotes"."issued_on" is null) = ("quote_quotes"."valid_until" is null)),
	CONSTRAINT "quote_quotes_snapshot_check" CHECK (("quote_quotes"."status" = 'draft') = ("quote_quotes"."totals_snapshot" is null)),
	CONSTRAINT "quote_quotes_decided_check" CHECK (("quote_quotes"."status" in ('accepted', 'declined')) = ("quote_quotes"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "story_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"board_asset_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "story_characters_name_check" CHECK (length(btrim("story_characters"."name")) between 1 and 120),
	CONSTRAINT "story_characters_description_check" CHECK (length("story_characters"."description") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "story_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"heading" text NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	CONSTRAINT "story_scenes_story_scope_key" UNIQUE("id","story_id"),
	CONSTRAINT "story_scenes_number_check" CHECK ("story_scenes"."number" >= 1),
	CONSTRAINT "story_scenes_heading_check" CHECK (length(btrim("story_scenes"."heading")) between 1 and 200),
	CONSTRAINT "story_scenes_synopsis_check" CHECK (length("story_scenes"."synopsis") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "story_shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"action" text NOT NULL,
	"duration_s" numeric(6, 2),
	"image_variant_id" uuid,
	"video_variant_id" uuid,
	"character_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'boarded' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "story_shots_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "story_shots_number_check" CHECK ("story_shots"."number" >= 1),
	CONSTRAINT "story_shots_status_check" CHECK ("story_shots"."status" in ('boarded', 'generated', 'edited', 'done')),
	CONSTRAINT "story_shots_action_check" CHECK (length(btrim("story_shots"."action")) between 1 and 2000),
	CONSTRAINT "story_shots_duration_check" CHECK ("story_shots"."duration_s" is null or "story_shots"."duration_s" > 0),
	CONSTRAINT "story_shots_notes_check" CHECK (length("story_shots"."notes") <= 4000),
	CONSTRAINT "story_shots_cast_check" CHECK (cardinality("story_shots"."character_ids") <= 20)
);
--> statement-breakpoint
CREATE TABLE "story_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"logline" text DEFAULT '' NOT NULL,
	"script" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "story_stories_owner_scope_key" UNIQUE("id","owner_id"),
	CONSTRAINT "story_stories_project_scope_key" UNIQUE("id","project_id"),
	CONSTRAINT "story_stories_title_check" CHECK (length(btrim("story_stories"."title")) between 1 and 200),
	CONSTRAINT "story_stories_logline_check" CHECK (length("story_stories"."logline") <= 1000),
	CONSTRAINT "story_stories_script_check" CHECK (length("story_stories"."script") <= 200000)
);
--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_routine_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."agent_routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_task_fk" FOREIGN KEY ("task_id","owner_id") REFERENCES "public"."ops_tasks"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_run_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."ops_agent_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_llm_fk" FOREIGN KEY ("llm_connection_id","owner_id") REFERENCES "public"."provider_connections"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assets" ADD CONSTRAINT "asset_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assets" ADD CONSTRAINT "asset_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assets" ADD CONSTRAINT "asset_assets_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_collection_fk" FOREIGN KEY ("collection_id","owner_id") REFERENCES "public"."asset_collections"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_asset_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collections" ADD CONSTRAINT "asset_collections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collections" ADD CONSTRAINT "asset_collections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_collections" ADD CONSTRAINT "asset_collections_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_generation_jobs" ADD CONSTRAINT "asset_generation_jobs_task_fk" FOREIGN KEY ("task_id","owner_id") REFERENCES "public"."ops_tasks"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_boards" ADD CONSTRAINT "board_boards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_boards" ADD CONSTRAINT "board_boards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_boards" ADD CONSTRAINT "board_boards_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_events" ADD CONSTRAINT "board_card_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_events" ADD CONSTRAINT "board_card_events_card_fk" FOREIGN KEY ("card_id","owner_id") REFERENCES "public"."board_cards"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_events" ADD CONSTRAINT "board_card_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_board_fk" FOREIGN KEY ("board_id","owner_id") REFERENCES "public"."board_boards"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_lane_fk" FOREIGN KEY ("lane_id","board_id") REFERENCES "public"."board_lanes"("id","board_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_lanes" ADD CONSTRAINT "board_lanes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_lanes" ADD CONSTRAINT "board_lanes_board_fk" FOREIGN KEY ("board_id","owner_id") REFERENCES "public"."board_boards"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_state" ADD CONSTRAINT "calendar_sync_state_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_settings" ADD CONSTRAINT "owner_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refs" ADD CONSTRAINT "refs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_decisions" ADD CONSTRAINT "exp_decisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_decisions" ADD CONSTRAINT "exp_decisions_experiment_fk" FOREIGN KEY ("experiment_id","owner_id") REFERENCES "public"."exp_experiments"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_decisions" ADD CONSTRAINT "exp_decisions_winner_fk" FOREIGN KEY ("winner_variant_id","experiment_id") REFERENCES "public"."exp_variants"("id","experiment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_experiments" ADD CONSTRAINT "exp_experiments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_experiments" ADD CONSTRAINT "exp_experiments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_experiments" ADD CONSTRAINT "exp_experiments_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_items" ADD CONSTRAINT "exp_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_items" ADD CONSTRAINT "exp_items_experiment_fk" FOREIGN KEY ("experiment_id","owner_id") REFERENCES "public"."exp_experiments"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_items" ADD CONSTRAINT "exp_items_variant_fk" FOREIGN KEY ("variant_id","experiment_id") REFERENCES "public"."exp_variants"("id","experiment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_learnings" ADD CONSTRAINT "exp_learnings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_learnings" ADD CONSTRAINT "exp_learnings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_learnings" ADD CONSTRAINT "exp_learnings_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_learnings" ADD CONSTRAINT "exp_learnings_experiment_fk" FOREIGN KEY ("experiment_id","owner_id") REFERENCES "public"."exp_experiments"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_variants" ADD CONSTRAINT "exp_variants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exp_variants" ADD CONSTRAINT "exp_variants_experiment_fk" FOREIGN KEY ("experiment_id","owner_id") REFERENCES "public"."exp_experiments"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_listing_fk" FOREIGN KEY ("listing_id","project_id") REFERENCES "public"."market_listings"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_marketplace_fk" FOREIGN KEY ("marketplace_id","project_id") REFERENCES "public"."market_marketplaces"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_intents" ADD CONSTRAINT "market_intents_authorization_fk" FOREIGN KEY ("authorization_id","owner_id") REFERENCES "public"."ops_release_authorizations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_product_fk" FOREIGN KEY ("product_id","project_id") REFERENCES "public"."market_products"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_marketplace_fk" FOREIGN KEY ("marketplace_id","project_id") REFERENCES "public"."market_marketplaces"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_marketplaces" ADD CONSTRAINT "market_marketplaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_marketplaces" ADD CONSTRAINT "market_marketplaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_marketplaces" ADD CONSTRAINT "market_marketplaces_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_marketplaces" ADD CONSTRAINT "market_marketplaces_connection_fk" FOREIGN KEY ("connection_id","owner_id") REFERENCES "public"."provider_connections"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_marketplace_fk" FOREIGN KEY ("marketplace_id","project_id") REFERENCES "public"."market_marketplaces"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_product_files" ADD CONSTRAINT "market_product_files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_product_files" ADD CONSTRAINT "market_product_files_product_fk" FOREIGN KEY ("product_id","owner_id") REFERENCES "public"."market_products"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_product_files" ADD CONSTRAINT "market_product_files_asset_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_products" ADD CONSTRAINT "market_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_products" ADD CONSTRAINT "market_products_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_products" ADD CONSTRAINT "market_products_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_sales_events" ADD CONSTRAINT "market_sales_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_sales_events" ADD CONSTRAINT "market_sales_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_sales_events" ADD CONSTRAINT "market_sales_events_marketplace_fk" FOREIGN KEY ("marketplace_id","project_id") REFERENCES "public"."market_marketplaces"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_sales_events" ADD CONSTRAINT "market_sales_events_listing_fk" FOREIGN KEY ("listing_id","project_id") REFERENCES "public"."market_listings"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_sales_events" ADD CONSTRAINT "market_sales_events_supersedes_fk" FOREIGN KEY ("supersedes_id","owner_id") REFERENCES "public"."market_sales_events"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_agent_runs" ADD CONSTRAINT "ops_agent_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_agent_runs" ADD CONSTRAINT "ops_agent_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_agent_runs" ADD CONSTRAINT "ops_agent_runs_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_agent_runs" ADD CONSTRAINT "ops_agent_runs_task_fk" FOREIGN KEY ("task_id","owner_id") REFERENCES "public"."ops_tasks"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_audit_events" ADD CONSTRAINT "ops_audit_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_audit_events" ADD CONSTRAINT "ops_audit_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_budget_reservations" ADD CONSTRAINT "ops_budget_reservations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_budget_reservations" ADD CONSTRAINT "ops_budget_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_budget_reservations" ADD CONSTRAINT "ops_budget_reservations_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_budget_reservations" ADD CONSTRAINT "ops_budget_reservations_policy_fk" FOREIGN KEY ("policy_id","owner_id") REFERENCES "public"."ops_policies"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_capability_checks" ADD CONSTRAINT "ops_capability_checks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_capability_checks" ADD CONSTRAINT "ops_capability_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_capability_checks" ADD CONSTRAINT "ops_capability_checks_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_capability_checks" ADD CONSTRAINT "ops_capability_checks_connection_fk" FOREIGN KEY ("connection_id","owner_id") REFERENCES "public"."provider_connections"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_event_deliveries" ADD CONSTRAINT "ops_event_deliveries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_event_deliveries" ADD CONSTRAINT "ops_event_deliveries_event_fk" FOREIGN KEY ("event_id","owner_id") REFERENCES "public"."ops_outbox_events"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_event_deliveries" ADD CONSTRAINT "ops_event_deliveries_runtime_fk" FOREIGN KEY ("runtime_id","owner_id") REFERENCES "public"."ops_runtimes"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_requests" ADD CONSTRAINT "ops_human_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_requests" ADD CONSTRAINT "ops_human_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_requests" ADD CONSTRAINT "ops_human_requests_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_requests" ADD CONSTRAINT "ops_human_requests_task_fk" FOREIGN KEY ("task_id","owner_id") REFERENCES "public"."ops_tasks"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_responses" ADD CONSTRAINT "ops_human_responses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_responses" ADD CONSTRAINT "ops_human_responses_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_responses" ADD CONSTRAINT "ops_human_responses_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_human_responses" ADD CONSTRAINT "ops_human_responses_request_fk" FOREIGN KEY ("request_id","owner_id") REFERENCES "public"."ops_human_requests"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_idempotency_keys" ADD CONSTRAINT "ops_idempotency_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_idempotency_keys" ADD CONSTRAINT "ops_idempotency_keys_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_inbound_events" ADD CONSTRAINT "ops_inbound_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_inbound_events" ADD CONSTRAINT "ops_inbound_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_kill_switches" ADD CONSTRAINT "ops_kill_switches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_kill_switches" ADD CONSTRAINT "ops_kill_switches_engaged_by_users_id_fk" FOREIGN KEY ("engaged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_kill_switches" ADD CONSTRAINT "ops_kill_switches_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_kill_switches" ADD CONSTRAINT "ops_kill_switches_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_outbox_events" ADD CONSTRAINT "ops_outbox_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_outbox_events" ADD CONSTRAINT "ops_outbox_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_policies" ADD CONSTRAINT "ops_policies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_policies" ADD CONSTRAINT "ops_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_policies" ADD CONSTRAINT "ops_policies_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_policies" ADD CONSTRAINT "ops_policies_supersedes_fk" FOREIGN KEY ("supersedes_id","owner_id") REFERENCES "public"."ops_policies"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_release_authorizations" ADD CONSTRAINT "ops_release_authorizations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_release_authorizations" ADD CONSTRAINT "ops_release_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_release_authorizations" ADD CONSTRAINT "ops_release_authorizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_release_authorizations" ADD CONSTRAINT "ops_release_authorizations_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_release_authorizations" ADD CONSTRAINT "ops_release_authorizations_policy_fk" FOREIGN KEY ("policy_id","owner_id") REFERENCES "public"."ops_policies"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_run_checkpoints" ADD CONSTRAINT "ops_run_checkpoints_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_run_checkpoints" ADD CONSTRAINT "ops_run_checkpoints_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_run_checkpoints" ADD CONSTRAINT "ops_run_checkpoints_run_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."ops_agent_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_runtimes" ADD CONSTRAINT "ops_runtimes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_runtimes" ADD CONSTRAINT "ops_runtimes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_runtimes" ADD CONSTRAINT "ops_runtimes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_usage_events" ADD CONSTRAINT "ops_usage_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_usage_events" ADD CONSTRAINT "ops_usage_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_usage_events" ADD CONSTRAINT "ops_usage_events_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_usage_events" ADD CONSTRAINT "ops_usage_events_reservation_fk" FOREIGN KEY ("reservation_id","owner_id") REFERENCES "public"."ops_budget_reservations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_examples" ADD CONSTRAINT "prompt_examples_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_examples" ADD CONSTRAINT "prompt_examples_variant_fk" FOREIGN KEY ("variant_id","owner_id") REFERENCES "public"."prompt_variants"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_examples" ADD CONSTRAINT "prompt_examples_asset_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_prompts" ADD CONSTRAINT "prompt_prompts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_prompts" ADD CONSTRAINT "prompt_prompts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_prompts" ADD CONSTRAINT "prompt_prompts_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variants" ADD CONSTRAINT "prompt_variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variants" ADD CONSTRAINT "prompt_variants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variants" ADD CONSTRAINT "prompt_variants_prompt_fk" FOREIGN KEY ("prompt_id","owner_id") REFERENCES "public"."prompt_prompts"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_connection_fk" FOREIGN KEY ("connection_id","owner_id") REFERENCES "public"."provider_connections"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_post_fk" FOREIGN KEY ("post_id","project_id") REFERENCES "public"."publish_posts"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_account_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."publish_accounts"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_authorization_fk" FOREIGN KEY ("authorization_id","owner_id") REFERENCES "public"."ops_release_authorizations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_account_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."publish_accounts"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_posts" ADD CONSTRAINT "publish_posts_asset_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_readings" ADD CONSTRAINT "publish_readings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_readings" ADD CONSTRAINT "publish_readings_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_readings" ADD CONSTRAINT "publish_readings_post_fk" FOREIGN KEY ("post_id","project_id") REFERENCES "public"."publish_posts"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_readings" ADD CONSTRAINT "publish_readings_account_fk" FOREIGN KEY ("account_id","project_id") REFERENCES "public"."publish_accounts"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_readings" ADD CONSTRAINT "publish_readings_supersedes_fk" FOREIGN KEY ("supersedes_id","owner_id") REFERENCES "public"."publish_readings"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_clients" ADD CONSTRAINT "quote_clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_clients" ADD CONSTRAINT "quote_clients_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_fk" FOREIGN KEY ("quote_id","owner_id") REFERENCES "public"."quote_quotes"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_quotes" ADD CONSTRAINT "quote_quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_quotes" ADD CONSTRAINT "quote_quotes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_quotes" ADD CONSTRAINT "quote_quotes_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_quotes" ADD CONSTRAINT "quote_quotes_client_fk" FOREIGN KEY ("client_id","owner_id") REFERENCES "public"."quote_clients"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_quotes" ADD CONSTRAINT "quote_quotes_pdf_fk" FOREIGN KEY ("pdf_asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_story_fk" FOREIGN KEY ("story_id","owner_id") REFERENCES "public"."story_stories"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_board_fk" FOREIGN KEY ("board_asset_id","owner_id") REFERENCES "public"."asset_assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_scenes" ADD CONSTRAINT "story_scenes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_scenes" ADD CONSTRAINT "story_scenes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_scenes" ADD CONSTRAINT "story_scenes_story_fk" FOREIGN KEY ("story_id","owner_id") REFERENCES "public"."story_stories"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_image_variant_id_prompt_variants_id_fk" FOREIGN KEY ("image_variant_id") REFERENCES "public"."prompt_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_video_variant_id_prompt_variants_id_fk" FOREIGN KEY ("video_variant_id") REFERENCES "public"."prompt_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_story_fk" FOREIGN KEY ("story_id","project_id") REFERENCES "public"."story_stories"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_scene_fk" FOREIGN KEY ("scene_id","story_id") REFERENCES "public"."story_scenes"("id","story_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_shots" ADD CONSTRAINT "story_shots_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_stories" ADD CONSTRAINT "story_stories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_stories" ADD CONSTRAINT "story_stories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_stories" ADD CONSTRAINT "story_stories_project_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."projects"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proposals_owner_idx" ON "agent_proposals" USING btree ("owner_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_proposals_routine_idx" ON "agent_proposals" USING btree ("routine_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_proposals_run_idx" ON "agent_proposals" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_routines_name_key" ON "agent_routines" USING btree ("owner_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "agent_routines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "agent_routines_due_idx" ON "agent_routines" USING btree ("next_due_at") WHERE "agent_routines"."enabled" and "agent_routines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "agent_routines_owner_idx" ON "agent_routines" USING btree ("owner_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_assets_storage_key" ON "asset_assets" USING btree ("storage_provider","storage_key");--> statement-breakpoint
CREATE INDEX "asset_assets_owner_idx" ON "asset_assets" USING btree ("owner_id","project_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "asset_assets_tags_idx" ON "asset_assets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "asset_collection_items_asset_idx" ON "asset_collection_items" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_collections_name_key" ON "asset_collections" USING btree ("owner_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "asset_generation_jobs_owner_idx" ON "asset_generation_jobs" USING btree ("owner_id","project_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "asset_generation_jobs_target_idx" ON "asset_generation_jobs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_generation_jobs_task_key" ON "asset_generation_jobs" USING btree ("task_id") WHERE "asset_generation_jobs"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "board_boards_owner_idx" ON "board_boards" USING btree ("owner_id","project_id","position");--> statement-breakpoint
CREATE INDEX "board_card_events_card_idx" ON "board_card_events" USING btree ("card_id","occurred_at");--> statement-breakpoint
CREATE INDEX "board_card_events_owner_idx" ON "board_card_events" USING btree ("owner_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "board_cards_lane_idx" ON "board_cards" USING btree ("lane_id","position") WHERE "board_cards"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "board_cards_owner_idx" ON "board_cards" USING btree ("owner_id","project_id","archived_at");--> statement-breakpoint
CREATE INDEX "board_cards_labels_idx" ON "board_cards" USING gin ("labels");--> statement-breakpoint
CREATE UNIQUE INDEX "board_lanes_position_key" ON "board_lanes" USING btree ("board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "board_lanes_awaiting_key" ON "board_lanes" USING btree ("board_id") WHERE "board_lanes"."role" = 'awaiting_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_google_key" ON "calendar_events" USING btree ("owner_id","google_calendar_id","google_event_id") WHERE "calendar_events"."google_event_id" is not null;--> statement-breakpoint
CREATE INDEX "calendar_events_range_idx" ON "calendar_events" USING btree ("owner_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_events_pending_idx" ON "calendar_events" USING btree ("owner_id","sync_state") WHERE "calendar_events"."sync_state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "google_connections_owner_key" ON "google_connections" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id","status","position");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_label_key" ON "provider_connections" USING btree ("owner_id","provider","label") WHERE "provider_connections"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "refs_edge_key" ON "refs" USING btree ("from_type","from_id","to_type","to_id","role");--> statement-breakpoint
CREATE INDEX "refs_from_idx" ON "refs" USING btree ("owner_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX "refs_to_idx" ON "refs" USING btree ("owner_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX "exp_decisions_experiment_idx" ON "exp_decisions" USING btree ("experiment_id","decided_at");--> statement-breakpoint
CREATE INDEX "exp_experiments_owner_idx" ON "exp_experiments" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "exp_items_subject_key" ON "exp_items" USING btree ("experiment_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "exp_items_subject_idx" ON "exp_items" USING btree ("owner_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "exp_learnings_owner_idx" ON "exp_learnings" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE INDEX "exp_learnings_tags_idx" ON "exp_learnings" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "exp_variants_label_key" ON "exp_variants" USING btree ("experiment_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "market_intents_idempotency_key" ON "market_intents" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "market_intents_live_key" ON "market_intents" USING btree ("listing_id") WHERE "market_intents"."status" in ('submitting', 'submitted', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "market_intents_remote_key" ON "market_intents" USING btree ("marketplace_id","remote_listing_id") WHERE "market_intents"."remote_listing_id" is not null;--> statement-breakpoint
CREATE INDEX "market_intents_queue_idx" ON "market_intents" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_listings_live_key" ON "market_listings" USING btree ("product_id","marketplace_id") WHERE "market_listings"."status" not in ('inactive', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "market_listings_external_key" ON "market_listings" USING btree ("marketplace_id","external_id") WHERE "market_listings"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "market_listings_owner_idx" ON "market_listings" USING btree ("owner_id","project_id","status","listed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_marketplaces_shop_key" ON "market_marketplaces" USING btree ("project_id","kind",lower("shop")) WHERE "market_marketplaces"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "market_payouts_reference_key" ON "market_payouts" USING btree ("marketplace_id","reference") WHERE "market_payouts"."reference" is not null;--> statement-breakpoint
CREATE INDEX "market_payouts_owner_idx" ON "market_payouts" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "market_product_files_key" ON "market_product_files" USING btree ("product_id","asset_id","role");--> statement-breakpoint
CREATE INDEX "market_product_files_asset_idx" ON "market_product_files" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "market_products_owner_idx" ON "market_products" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "market_sales_events_supersedes_key" ON "market_sales_events" USING btree ("supersedes_id") WHERE "market_sales_events"."supersedes_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "market_sales_events_order_key" ON "market_sales_events" USING btree ("marketplace_id","kind","order_ref") WHERE "market_sales_events"."order_ref" is not null and "market_sales_events"."supersedes_id" is null;--> statement-breakpoint
CREATE INDEX "market_sales_events_owner_idx" ON "market_sales_events" USING btree ("owner_id","project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "market_sales_events_listing_idx" ON "market_sales_events" USING btree ("listing_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notes_board_idx" ON "notes" USING btree ("owner_id","deleted_at","archived_at","pinned" DESC NULLS LAST,"position","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_labels_idx" ON "notes" USING gin ("labels");--> statement-breakpoint
CREATE INDEX "notes_project_idx" ON "notes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ops_agent_runs_task_idx" ON "ops_agent_runs" USING btree ("task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ops_agent_runs_status_idx" ON "ops_agent_runs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "ops_audit_owner_idx" ON "ops_audit_events" USING btree ("owner_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ops_audit_project_idx" ON "ops_audit_events" USING btree ("project_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ops_audit_target_idx" ON "ops_audit_events" USING btree ("target_type","target_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ops_budget_reservations_open_idx" ON "ops_budget_reservations" USING btree ("owner_id","project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ops_capability_checks_lookup_idx" ON "ops_capability_checks" USING btree ("owner_id","provider","capability","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ops_event_deliveries_key" ON "ops_event_deliveries" USING btree ("event_id","runtime_id");--> statement-breakpoint
CREATE INDEX "ops_event_deliveries_due_idx" ON "ops_event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_human_requests_open_key" ON "ops_human_requests" USING btree ("owner_id","dedupe_key") WHERE "ops_human_requests"."dedupe_key" is not null and "ops_human_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ops_human_requests_open_idx" ON "ops_human_requests" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_human_responses_request_key" ON "ops_human_responses" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_idempotency_keys_key" ON "ops_idempotency_keys" USING btree ("actor_id","key");--> statement-breakpoint
CREATE INDEX "ops_idempotency_keys_expires_idx" ON "ops_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_inbound_events_key" ON "ops_inbound_events" USING btree ("source","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_kill_switches_engaged_key" ON "ops_kill_switches" USING btree ("owner_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"scope",coalesce("target", '')) WHERE "ops_kill_switches"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_outbox_events_dedupe_key" ON "ops_outbox_events" USING btree ("owner_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ops_outbox_events_pending_idx" ON "ops_outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_policies_revision_key" ON "ops_policies" USING btree ("owner_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"revision_no");--> statement-breakpoint
CREATE INDEX "ops_release_authorizations_subject_idx" ON "ops_release_authorizations" USING btree ("subject_type","subject_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_runtimes_grant_key" ON "ops_runtimes" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_tasks_trigger_key" ON "ops_tasks" USING btree ("owner_id","trigger_key") WHERE "ops_tasks"."trigger_key" is not null;--> statement-breakpoint
CREATE INDEX "ops_tasks_queue_idx" ON "ops_tasks" USING btree ("owner_id","status","priority" DESC NULLS LAST,"due_at");--> statement-breakpoint
CREATE INDEX "ops_tasks_project_idx" ON "ops_tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ops_usage_events_subject_idx" ON "ops_usage_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ops_usage_events_owner_idx" ON "ops_usage_events" USING btree ("owner_id","project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_examples_asset_key" ON "prompt_examples" USING btree ("variant_id","asset_id");--> statement-breakpoint
CREATE INDEX "prompt_examples_asset_idx" ON "prompt_examples" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "prompt_prompts_owner_idx" ON "prompt_prompts" USING btree ("owner_id","project_id","archived_at","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prompt_prompts_tags_idx" ON "prompt_prompts" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_variants_label_key" ON "prompt_variants" USING btree ("prompt_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_variants_default_key" ON "prompt_variants" USING btree ("prompt_id") WHERE "prompt_variants"."is_default";--> statement-breakpoint
CREATE INDEX "prompt_variants_prompt_idx" ON "prompt_variants" USING btree ("prompt_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_accounts_handle_key" ON "publish_accounts" USING btree ("project_id","platform",lower("handle")) WHERE "publish_accounts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "publish_accounts_owner_idx" ON "publish_accounts" USING btree ("owner_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_intents_idempotency_key" ON "publish_intents" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_intents_live_key" ON "publish_intents" USING btree ("post_id") WHERE "publish_intents"."status" in ('submitting', 'submitted', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "publish_intents_remote_key" ON "publish_intents" USING btree ("account_id","remote_post_id") WHERE "publish_intents"."remote_post_id" is not null;--> statement-breakpoint
CREATE INDEX "publish_intents_queue_idx" ON "publish_intents" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_posts_external_key" ON "publish_posts" USING btree ("account_id","external_id") WHERE "publish_posts"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_posts_url_key" ON "publish_posts" USING btree ("account_id","url") WHERE "publish_posts"."url" is not null;--> statement-breakpoint
CREATE INDEX "publish_posts_owner_idx" ON "publish_posts" USING btree ("owner_id","project_id","status","posted_at");--> statement-breakpoint
CREATE INDEX "publish_posts_account_idx" ON "publish_posts" USING btree ("account_id","posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_readings_supersedes_key" ON "publish_readings" USING btree ("supersedes_id") WHERE "publish_readings"."supersedes_id" is not null;--> statement-breakpoint
CREATE INDEX "publish_readings_post_idx" ON "publish_readings" USING btree ("post_id","metric","as_of");--> statement-breakpoint
CREATE INDEX "publish_readings_account_idx" ON "publish_readings" USING btree ("account_id","metric","as_of");--> statement-breakpoint
CREATE INDEX "publish_readings_owner_idx" ON "publish_readings" USING btree ("owner_id","project_id","metric","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_clients_name_key" ON "quote_clients" USING btree ("owner_id",lower("name")) WHERE "quote_clients"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "quote_lines_quote_idx" ON "quote_lines" USING btree ("quote_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_quotes_number_key" ON "quote_quotes" USING btree ("owner_id","number");--> statement-breakpoint
CREATE INDEX "quote_quotes_owner_idx" ON "quote_quotes" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE INDEX "story_characters_story_idx" ON "story_characters" USING btree ("story_id","position");--> statement-breakpoint
CREATE INDEX "story_scenes_story_idx" ON "story_scenes" USING btree ("story_id","number");--> statement-breakpoint
CREATE INDEX "story_shots_scene_idx" ON "story_shots" USING btree ("scene_id","number");--> statement-breakpoint
CREATE INDEX "story_shots_owner_idx" ON "story_shots" USING btree ("owner_id","project_id","status");--> statement-breakpoint
CREATE INDEX "story_stories_owner_idx" ON "story_stories" USING btree ("owner_id","project_id","position");