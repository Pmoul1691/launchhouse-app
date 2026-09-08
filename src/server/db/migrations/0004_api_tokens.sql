-- Bearer tokens, for a client that is not a browser and has no cookie jar.
--
-- Claude's custom connector UI on the web accepts an OAuth client id and secret and
-- nothing else, so a token authed MCP endpoint cannot be added as a connector there.
-- It can be added to Claude Desktop's local config, where headers are supported. This
-- is the credential that config presents.
--
-- The id is a hash of the token and the passphrase, never the token, so a dump of this
-- database holds nothing anybody can present. See tokenIdFor in
-- src/server/auth/api-token.ts, which also carries the reason a passphrase change
-- invalidates every row here on purpose.
--
-- NO ROW LEVEL SECURITY ON THIS TABLE, AND IT IS NOT AN OVERSIGHT. Every policy in
-- rls.sql filters on current_setting('app.founder_id'). This is the table that decides
-- which founder a request is, so at the moment it is read nothing has been set, the
-- filter is null, and every lookup would match zero rows. No token would ever work.
-- "sessions" is absent from rls.sql for exactly the same reason.
--
-- expires_at is NOT NULL so that "never expires" cannot be written by accident.
--
-- HAND WRITTEN, like 0002 and 0003, and that is a departure worth naming. meta/ holds
-- snapshots for 0000 and 0001 only, so drizzle-kit would diff schema.ts against 0001
-- and emit this table plus connections.accounts and threads.last_refusal a second
-- time, with no IF NOT EXISTS, which fails at boot on a database that already has
-- them. Repairing that snapshot drift is its own commit.
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"founder_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_founder_id_founder_id_fk" FOREIGN KEY ("founder_id") REFERENCES "public"."founder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_founder_idx" ON "api_tokens" USING btree ("founder_id");
