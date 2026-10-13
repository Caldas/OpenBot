CREATE TABLE "pending_authorizations" (
	"actor_id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"action" text NOT NULL,
	"holder" text NOT NULL,
	"user_id" text,
	"vendor_user_id" text NOT NULL,
	"auth_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "brokered_connections" DROP CONSTRAINT "brokered_connections_provider_check";--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokered_connections" ADD CONSTRAINT "brokered_connections_provider_check" CHECK ("brokered_connections"."provider" IN ('composio', 'arcade'));