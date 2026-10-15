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

Grant moderation access to a trusted account:

```sql
UPDATE users SET is_staff = TRUE WHERE email = 'moderator@example.com';
```

The staff queue lives at `/staff/moderation`. Revoking the flag takes effect on
the next request.

Organization credentials created or updated after `0018` must contain bcrypt
hashes. Existing non-bcrypt credentials are deliberately not auto-converted:
their plaintext values must not be exported or re-saved. Reset those credentials
through an approved one-time administrative process before enabling login.
