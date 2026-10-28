CREATE TABLE "entity_links" (
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"local_id" integer NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_links_kind_provider_provider_ref_pk" PRIMARY KEY("kind","provider","provider_ref")
);
--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD COLUMN "pricing_note" text;--> statement-breakpoint
CREATE INDEX "entity_links_local_idx" ON "entity_links" USING btree ("kind","local_id");