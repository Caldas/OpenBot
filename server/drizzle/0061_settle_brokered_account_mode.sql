-- Every brokered app that HAS an account says whose, on the deployments where one already does not.
--
-- `addBrokeredApp` settles `account_mode` on its INSERT and, from this change on, after its upsert
-- as well. Its CONFLICT arm never did, so an enable that landed on a row that was not brokered —
-- one added by hand, restored, or left by a build that spelled ids differently — converted it to a
-- brokered app and left this column null. `accountFor` refuses a call against such a row as
-- ambiguous ("does not say whether it is reached through each person's account or a shared one"),
-- so the app is enabled, listed, connectable and dead.
--
-- THIS RUNS BECAUSE THE CODE FIX CANNOT REACH THOSE ROWS. An app that is already enabled cannot be
-- added again without being removed first — the Plugins page's Add is a switch, and switching it
-- off deletes the app and every connection on it — so "press Add again" is not a remedy an
-- administrator can perform, and the Plugins page offers no way to say Personal: it reads any
-- non-`shared` value as Personal already and shows only "Make shared". A fix in the writer alone
-- would leave every deployment that is already in this state in it forever.
--
-- `personal` is what the insert writes for a new app and the conservative answer: each person
-- reaches their own account. `shared` would hand everybody one account nobody chose to share.
--
-- ONLY ROWS WITH AN ACCOUNT TO HOLD, and `NO_AUTH` is the one scheme with none — `schemeKind`'s
-- `none`, the same set `mcp_servers.account_mode` is documented as null for. A null `auth_scheme`
-- is NOT in that set: it is `unreadable`, which `accountFor` treats as having an account, so such a
-- row is refused exactly as a recorded `OAUTH2` one is and needs the mode just as much.
--
-- ONLY ROWS THAT SAY NOTHING. A deployment that chose Shared keeps it.
UPDATE "mcp_servers"
   SET "account_mode" = 'personal'
 WHERE "provenance" IN ('composio', 'arcade')
   AND "account_mode" IS NULL
   AND ("auth_scheme" IS NULL OR "auth_scheme" <> 'NO_AUTH');
