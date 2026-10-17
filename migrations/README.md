# PitchNest database migrations

Migrations are applied in numeric order. Migration `0018` introduces the
`schema_migrations` ledger; every later migration must insert its own version in
the same transaction as its schema changes.

Before applying migrations to an existing environment:

1. Take a database backup or create a restorable snapshot.
2. Compare the target schema with `0000_complete_fresh_setup.sql` and the
   numbered migrations that follow it.
3. Do not backfill pre-0018 ledger rows from filenames alone. Record an older
   migration only after verifying its tables, columns, functions, policies, and
   storage configuration in that environment.
4. Apply the next migration in a transaction where PostgreSQL permits it.
5. Verify the new `schema_migrations` row and run the backend and frontend type
   checks before deployment.

Rollback policy: production schema changes use forward-fix migrations. Restore
from the pre-deployment snapshot only when a forward fix cannot safely preserve
data.

## Ecosystem v2 migrations

Apply in order, staging first:

| Version | What it adds | After applying |
|---|---|---|
| `0018` | Migration ledger, org-session index, bcrypt constraint on new org credentials | Reset any non-bcrypt organization credentials before enabling org login |
| `0019` | Businesses, memberships, publication snapshots, audit log, practice drafts, `sessions.business_id`, `decks.business_id` | None |
| `0020` | Snapshot-only public Discover reads and sitemap functions | Verify `/api/public/businesses` returns only published profiles |
| `0021` | Supports, follows, comments, content reports, staff moderation, `users.is_staff` | Grant at least one moderator (below), then set `FEATURE_DISCOVER_ENGAGEMENT=true` on the backend |
| `0022` | Business updates, in-app notifications (written by triggers), `practice_drafts.source_comment_id` | None. Users control notifications in Settings → Notifications |
| `0023` | Community discussions and replies, reply notifications, community reports in the staff queue, `community_moderation_log` | Set `FEATURE_COMMUNITY=true` when moderators are ready |
| `0024` | Staff-curated opportunities with official source links and last-checked dates | Staff add listings at `/staff/opportunities` |
| `0025` | Privacy-safe product events (allowlisted names and properties) and a staff summary | Staff view counts at `/staff/analytics` |
| `0026` | Public text pitches (draft, consented publish, withdraw), pitch feedback categories on comments, pitch reports with hide and restore in the staff queue, pitch event names | Needs `FEATURE_DISCOVER_ENGAGEMENT=true`. Then set `FEATURE_PITCH_ARENA=true` |
| `0027` | Revokes direct billing-settlement RPC access, fixes function search paths, and locks down the trial-email ledger | Apply immediately. Verify only `service_role` can execute `grant_pro_access` afterward |
| `0028` | Business logo and cover images (`logo_file`, `cover_file`, recorded in the publication snapshot), image changes bump `profile_version`, and `business_members.public_title` for consenting public team members | Apply before deploying the backend that uses it. Published images are copied to `SUPABASE_PUBLIC_MEDIA_BUCKET` (defaults to the avatar bucket) under `business-media/` |
| `0029` | Founder pages and follows: `founder_handles`, `founder_follows`, `founder_business_announcements`, `notifications.actor_id`, `founder_update` / `founder_business` notifications (honouring `followedFounders`), and `list_user_notifications` with founder columns | Apply after `0028` and before deploying. Founder follows use `FEATURE_DISCOVER_ENGAGEMENT`; founder pages are public whenever a member consents on a published business |
| `0030` | JWT revocation, sign-in-method locking, atomic verification/password reset, verified and capacity-safe organization enrollment, atomic weekly quota claims, recoverable trial-email delivery leases, safe session-list projection, billing settlement invariants, and account-erasure-safe foreign keys | Apply after `0029` before deploying the matching backend. Recheck that only `service_role` can execute `grant_pro_access`, `claim_weekly_session_slot`, `claim_trial_email`, `consume_email_verification`, `consume_password_reset`, and `enroll_user_in_organization` |
| `0031` | Auto-renewing subscriptions on Flutterwave payment plans: `billing_provider_plans` (one Flutterwave plan per plan, term and price), `subscriptions` (at most one active per user; a retired one keeps `provider_cancel_pending` until Flutterwave confirms the cancel), `payments.kind` / `bonus_days` / `provider_plan_id` / `subscription_id`, and `start_subscription_from_payment` | Apply after `0030` and before deploying the backend that sells subscriptions. `FIRST_SUBSCRIPTION_FREE_MONTHS` (default 1, 0 turns it off) sets the free months on a first subscription. Recheck that only `service_role` can execute `start_subscription_from_payment` |

Grant moderation access to a trusted account:

```sql
UPDATE users SET is_staff = TRUE WHERE email = 'moderator@example.com';
```

The staff queue lives at `/staff/moderation`. Revoking the flag takes effect on
the next request.

## Organization credentials

Organization credentials created or updated after `0018` must contain bcrypt
hashes. Existing non-bcrypt credentials are deliberately not auto-converted:
their plaintext values must not be exported or re-saved.

`0030` updates every organization row, and each update re-checks the bcrypt
rule, so a database still holding a non-bcrypt value cannot apply `0030`.
Clear those values first; the combined upgrade below does this for you:

```sql
UPDATE "Organizations" SET password = NULL
WHERE password IS NOT NULL AND password !~ '^\$2[aby]\$[0-9]{2}\$.{53}$';
```

To give an organization a new password without the plain text reaching the SQL
editor's saved history, hash it on your own machine from the backend folder:

```bash
node -e "const b=require('bcryptjs');process.stdin.once('data',d=>console.log(b.hashSync(d.toString().trim(),12)))"
```

Type the password, press Enter and copy the printed hash. Then run, with the
organization's address:

```sql
UPDATE "Organizations"
SET password = '<hash>', auth_version = auth_version + 1,
    failed_login_attempts = 0, locked_until = NULL
WHERE email = 'organization@example.com';
```

## Upgrading an existing database from 0014

A database at the `0014` schema (one that predates migration `0015`) can be
brought to `0031` with the two files in `combined/` instead of applying each
migration by hand.

| File | What it does |
|---|---|
| `combined/check_schema_state.sql` | Read-only. Reports the 0014 prerequisites, which of 0015–0031 are applied, and data the upgrade will act on. |
| `combined/upgrade_0014_to_0031.sql` | Applies 0015–0031 in one transaction and skips any already applied. Before changing anything it stops, with a list, if part of the 0014 schema is missing or 0030 would reject existing data. Clears non-bcrypt organization passwords (above). |

1. Take a backup or restorable snapshot.
2. Run `check_schema_state.sql` in the Supabase SQL editor. The `prerequisites`
   row must say `ok`, and no `data:` row may say `blocks upgrade`.
3. Run `upgrade_0014_to_0031.sql`: DEV first, then PROD. Any error rolls the
   whole run back; fix what the message names and run the file again.
4. Run `check_schema_state.sql` again. Every migration should say `applied`,
   with the ledger `recorded` for 0018 onward.
5. Then deploy the backend that expects this schema, to Render and Lambda
   together.

Both files are generated from the numbered migrations. After changing or adding
a migration, run `npm run migrations:combined` and `npm run test:migrations` in
the backend. The test applies everything to an in-memory Postgres (PGlite) with
stand-ins for Supabase's roles and storage, and checks that the combined script
matches the numbered migrations, re-runs as a no-op, completes partly upgraded
databases, keeps existing rows and refuses bad prerequisites without changing
anything. It needs no network or real database.
