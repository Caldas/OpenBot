-- An attempt belongs to the person who started it, and only that person's deletion may take it.
--
-- `0060` keyed both `actor_id` and `user_id` to `users` and cascaded both. `actor_id` is the row's
-- owner (the primary key, the session subject the verifier matches). `user_id` is whose account the
-- attempt is for, which for a `person` attempt is always the actor — `accountRefFor` answers a
-- Personal app with `{ userId: actorId }` and the only writer copies that — but nothing in the
-- database said so. A row naming two people therefore died with EITHER of them: deleting one person
-- destroyed an attempt a DIFFERENT person had started and was consenting through.
--
-- So the equality becomes a CHECK, and `user_id` loses its own key and the index that served it.
-- Through the CHECK, `user_id` names a person exactly when `actor_id` does, and `actor_id`'s cascade
-- (B7's reasoning, unchanged) is the only one left that reaches this table from `users`.
--
-- NO PURGE BEFORE THE CHECK, unlike 0060's orphans. Every row the application writes already holds
-- the equality, so a violating row was written by hand; deleting it would be the very loss this
-- migration exists to stop. If one exists, the ADD CONSTRAINT refuses and names the constraint, and
-- an operator decides what that row was.
ALTER TABLE "pending_authorizations" DROP CONSTRAINT "pending_authorizations_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "pending_authorizations_user_idx";--> statement-breakpoint
ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_user_is_actor_check" CHECK ("pending_authorizations"."user_id" IS NULL OR "pending_authorizations"."user_id" = "pending_authorizations"."actor_id");
