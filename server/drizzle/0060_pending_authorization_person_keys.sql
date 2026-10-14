-- `pending_authorizations.actor_id` and `.user_id` named `users.id` from the day 0057 created the
-- table and carried no key, so a deleted person left attempt rows pointing at nobody. Both get the
-- key here, both CASCADE: an attempt is in-flight working state with a fifteen-minute life, holding
-- no grant and no secret, and what a person authorized is recorded in `audit_events`, which is
-- keyless on purpose so the trail outlives them. RESTRICT would instead make somebody undeletable
-- while a browser of theirs sat mid-redirect.
--
-- THE ORPHANS GO FIRST, because `ADD CONSTRAINT` is not conditional: on any deployment that has run
-- 0057 and since deleted a person, the statement below would stop dead on rows the column was never
-- able to refuse. They are deleted rather than repaired — there is nothing to repair a row to, and
-- nulling `user_id` would trip `pending_authorizations_holder_check` on a `person` attempt. Nothing
-- reads an attempt whose person is gone; the verifier finds attempts from a live session.
DELETE FROM "pending_authorizations"
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."id" = "pending_authorizations"."actor_id")
   OR ("pending_authorizations"."user_id" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."id" = "pending_authorizations"."user_id"));--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A foreign key is not indexed on the referencing side, so until now deleting one `mcp_servers` row
-- made 0057's cascade scan this table, and so did every lookup by server. `user_id` gets one for
-- the same reason, now that it is a key too.
CREATE INDEX "pending_authorizations_server_idx" ON "pending_authorizations" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "pending_authorizations_user_idx" ON "pending_authorizations" USING btree ("user_id");
