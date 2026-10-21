-- Asset titles (2026-09-29): the owner can rename a file in HQ. `name` stays the file name as uploaded (what a
-- download saves as); `title` is what HQ shows, null = the file name. It is not part of a ready asset's frozen
-- identity (asset_freeze_ready), so renaming a ready file is allowed. Additive: one nullable column + a CHECK.
ALTER TABLE "asset_assets" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "asset_assets" ADD CONSTRAINT "asset_assets_title_check" CHECK ("asset_assets"."title" is null or length(btrim("asset_assets"."title")) between 1 and 200);