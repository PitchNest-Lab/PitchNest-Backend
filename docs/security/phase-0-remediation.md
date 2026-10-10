# Phase 0 Security Remediation Report

- **Branch:** `security/phase-0-remediation` (local, not pushed, not deployed)
- **Base:** `main` @ `a65df04`
- **Date:** 2026-10-10
- **Status:** **Implemented and tested locally. Not deployed.** No database, AWS, Render or frontend change has been made.

## Summary

| ID | Vulnerability | Status |
|---|---|---|
| C1 | Nine `/api/organization/*` endpoints unauthenticated; scope taken from client `orgId` | Fixed + regression-tested |
| C2 | Organization login issued tokens without checking the password; full org row logged | Fixed + regression-tested |
| C2b | Org token identity collision: `Organizations.id` resolved as `users.id` on REST and WebSocket | Fixed + regression-tested (including tokens already issued) |
| H5 | `resume: true` skipped the weekly quota and attempt limits | Fixed + regression-tested |
| H6 | Client-supplied `video_url` was signed for download and deleted on purge | Fixed + regression-tested |

The regression tests were also run against **unfixed `main`** in a throwaway worktree. Every vulnerability test **fails there and passes on this branch**:
- org-auth: 0/9 pass on main
- recordings: 1/6 pass on main (the one that passes is the unchanged ownership check)
- live-socket: 0/4 pass on main

The baseline H5 run shows a quota-exhausted user getting a live session after sending `resume: true`.

---

## C1 — Unauthenticated organization endpoints

- **Root cause:** `organizationRoutes.ts` mounted every handler with no middleware. Each handler trusted `req.body.orgId`, an enumerable `org_code`.
- **Fix:**
  - New `orgAuthMiddleware`, applied router-wide so a route added later can't be left open by mistake.
  - It requires an org token (`typ:"org"`) and re-reads the `Organizations` row on every request. The row's `org_code` and `email` must still match the token.
  - Handlers use `resolveOrgScope()`: the scope is **always** the authenticated `org_code`. A client `orgId` is tolerated for compatibility but must equal that code, otherwise the request gets 403.

## C2 — Passwordless organization login and logging

- **Root cause:** `bcrypt.compare` was commented out (commit `c285fbe`), and `console.log(user)` printed the full row.
- **Fix:**
  - Login requires string `email` and `password` and a real bcrypt hash in `Organizations.password`. The comparison runs in constant time, against a dummy hash when there's no usable one.
  - Rows with a `NULL`, plaintext or other non-bcrypt value **cannot log in**. Nothing is created, upgraded or written back.
  - Logs carry only the org id, never the row, email or hash. This is enforced by a test that captures console output.
- **Unverified:** I had no database access, so I couldn't confirm whether production `Organizations` rows hold bcrypt hashes in a `password` column. If they don't, org login is now refused for those organizations. That fails closed, by design. See *Password setup flow* below.

## C2b — Token identity collision

- **Root cause:** founder and org tokens had the same shape (`{id, email}`), the same secret, and the same verifiers.
- **Fix:**
  - New `services/tokenService.ts`. Tokens carry `typ` (`"user"` or `"org"`). `verifyUserToken` rejects org tokens, and `verifyOrgToken` accepts only `typ:"org"`. Algorithms are pinned to HS256.
  - Org tokens carry `orgId` and `orgCode`, and no `id` claim.
  - **Tokens already issued:** pre-fix founder tokens stay valid, so nobody is logged out. But pre-fix org tokens have the same untyped shape. Every founder check (`authMiddleware`, and WebSocket `client_ready`) therefore now **binds the token's email to the `users` row**. An old org token carries the organization's email, which doesn't match the colliding founder, so it's refused.
  - This needed no secret rotation. Rotation is still an option if you want every outstanding token gone.
- **JWT compatibility:** same secret and algorithm, so tokens issued by Render and by Lambda stay mutually valid. New founder tokens add only the `typ` claim.

## H5 — Resume quota bypass

- **Root cause:** `isResume = !!data.resume` (client input) skipped `claimPitchAttempt` and `claimSessionSlot`.
- **Fix:**
  - New `services/liveSessionGrants.ts`. Each admitted session (after its claims pass) gets a server grant: user, attempt stamp, and a deadline fixed at admission.
  - A resume skips the claims **only** if it matches an un-ended grant for the same user, before deadline + 10 minutes. It can match in one of two ways:
    1. A signed resume token, sent to the client in a new additive `session_grant` message. This works across processes.
    2. The user's latest grant in this process. This is what keeps **today's frontend** (`resume: true`, no token) working without spending quota on a page refresh.
  - Any other resume is admitted as a new session and pays the normal claims. `resume` remains a UX hint only (rebuild history, skip greeting).
  - A resumed clock never exceeds the grant's remaining time.
  - `end_session` marks the grant ended, so one admission produces one session row.
  - A newer resume closes the older socket (code 4007).
  - Side fix: a resumed session now stamps the correct attempt number. It was previously `null`.

## H6 — Recording authorization

- **Root cause:** `set_video_url` stored any string. `getSessionRecording` signed it against the private bucket, and account purge deleted it.
- **Fix:**
  - New `utils/recordingAuth.ts`. Recording keys now encode the owner: `pitches/<userId>/…`, or `/uploads/rec_<userId>_…` for the local fallback.
  - `set_video_url` accepts only the caller's own keys and returns an `INVALID_RECORDING` error otherwise.
  - Signing, `/api/files` serving and purge all re-check ownership.
  - Legacy keys (no user segment) remain readable and deletable by their owner **only** if no other user's row references the same object. That check fails closed.
  - Decks, avatars and foreign URLs are never signed through this path.
  - `/api/upload-video` still returns `{ videoUrl }`. Only the key format changed, and the frontend echoes it back unchanged.

---

## B1 — Live Pitch actions without admission (found in release review)

- **Root cause:**
  - `verdict_request`, `prepare_evaluation` and `end_session` had no `client_ready`/setup guard. Any accepted token could obtain an AI evaluation and a saved session row.
  - That skipped the quota and attempt claims, the email-verification check and the token↔email binding. A legacy org token colliding with a founder id could write rows into that founder's account.
  - Reproduced with a probe on `7d47276`: a quota-exhausted founder, an unverified founder and a colliding legacy org token all received a report and a row.
- **Fix** (`restSocket.ts`):
  1. **At connect,** the founder row must exist, match the token email and be verified, otherwise the socket closes with 4001 (`USER_DELETED` / `EMAIL_NOT_VERIFIED`). The check starts immediately but isn't awaited before the message listener is registered; every message awaits it, so a fast `client_ready` is never dropped.
  2. **Admission:** the connection is admitted only after `client_ready` passes every gate (fresh quota and attempt claims, or a validated resume).
     - `end_session`, `verdict_request`, `prepare_evaluation` and `set_video_url` require admission. If they arrive while `client_ready` is still running, they wait for its outcome (bounded to 30 s) rather than being dropped.
     - `chat_message`, `audio_chunk`, binary audio, `interrupt` and `deck_slide` are dropped until admitted.
     - A closed socket settles admission as failed.
- **Legitimate flows preserved:** normal pitch, `end_session` sent immediately after `client_ready`, and refresh resume (existing tests) all still work. One admission still yields exactly one report and one quota slot.
- **Tests:** `src/tests/security/ws-admission.test.ts` has 7 tests. Each refusal case is paired with a positive control.

## Files changed

| File | Change |
|---|---|
| `src/services/tokenService.ts` (new) | Typed sign/verify, principal checks, HS256 pin |
| `src/middleware/orgAuthMiddleware.ts` (new) | Org gate + `resolveOrgScope` |
| `src/middleware/authMiddleware.ts` | Founder-only verify; email binding |
| `src/routes/organization/organizationRoutes.ts` | Router-wide org auth |
| `src/controllers/organization/organizationController.ts` | Scope from authenticated org |
| `src/controllers/authController.ts` | Org login with bcrypt; typed tokens; no row logging; purge uses recording ownership |
| `src/services/liveSessionGrants.ts` (new) | Server-side resume grants |
| `src/sockets/restSocket.ts` | Typed verify + email binding; validated resume; `set_video_url` validation; grant lifecycle; B1 connect-time principal check + admission gate |
| `src/utils/recordingAuth.ts` (new) | Recording key ownership rules |
| `src/controllers/uploadController.ts` | User-scoped recording keys |
| `src/controllers/sessionController.ts` | Sign only authorized recordings |
| `src/controllers/fileController.ts` | Re-check recording ownership at serve time |
| `src/config/supabase.ts` | Test seam (`__setSupabaseForTests`, refuses outside `NODE_ENV=test`) |
| `src/tests/helpers/*`, `src/tests/security/*` (new) | 32 regression tests |

## Tests performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| Existing `run_tests.ts` (45 assertions), `deck_type_test.ts` | Pass |
| `npx tsx --test src/tests/security/*.test.ts` | **39/39 pass** (32 + 7 for B1) |
| Same vulnerability tests on unfixed `main` | Fail as expected (above) |
| Lambda bundle (esbuild, same flags, built to a scratch directory) | Builds; `dist/` untouched |
| `server.ts` (Render entry point) local boot | `/api/health` 200; org route with no token → 401; WebSocket with bad token → close 4001 |

Coverage:
- unauthenticated requests, wrong-principal tokens, forged and `alg:none` tokens, expired tokens
- cross-org `orgId`, deleted orgs, legacy colliding org tokens on REST and WebSocket
- org passwords: missing, wrong, plaintext and NULL
- log leakage
- quota bypass: no token, forged token, ended session
- legitimate resume via the registry and via the token
- foreign recording signing, purge, local-file reads, upload key format

All tests use an in-memory Supabase fake and dummy secrets. Nothing contacts a real service.

## Frontend compatibility

- **Production frontend (`main`/`Maurice`):** contains no org UI. Its auth, refresh, Live Pitch and upload flows are unaffected:
  - the response shapes are unchanged
  - `session_grant` is a new message type, and the client ignores unknown types
  - `videoUrl` is echoed back unchanged
- **Org dashboard (`origin/abhi` only, unreleased):** needs three changes before release:
  1. Send `Authorization: Bearer <org token>` in `src/api/organization.ts`.
  2. Drop the hardcoded `ORG_ID = "12345"`. Read `user.orgCode` from the login response, or omit `orgId`.
  3. Store the org token separately from the founder `token` key. Founder routes now reject it.
- **Recommended follow-up (frontend):** save `session_grant.resumeToken` in `sessionStorage` and send it as `resumeToken` in the `client_ready` resume payload. That makes resume work across Live Pitch tasks once ECS runs more than one.

## Proposed: organization password setup (not applied)

If production org rows lack bcrypt hashes, don't set passwords by hand in the database. Proposed flow, which needs approval and a migration:
1. Migration: `organization_password_tokens (org_id, token_hash, expires_at, used_at)`.
2. An operator-only command, or an admin route behind `ADMIN_API_KEY`, mints a single-use 1-hour token and emails a setup link to the org's registered address through Resend.
3. `POST /api/auth/organization-set-password { token, password }` verifies the token hash, sets a bcrypt hash (cost 12), and marks the token used.
4. Reuse the same flow for "forgot password".

## Remaining risks

- **Per-process resume state.**
  - The "ended" flag and the one-socket-per-grant rule live in memory. With more than one Live Pitch process, a signed resume token shown to a process that didn't admit the session is accepted on signature and deadline alone. Abuse is bounded by the original session's remaining time.
  - On a single Render instance this is complete.
  - Durable single-use needs a `session_grants` table (proposed).
- **Registry fallback matches the user's latest session.** A user running two pitches in two tabs who refreshes the older tab resumes the newer one. Token-based resume avoids this.
- **Legacy poisoned rows.**
  - If a pre-fix row points at a victim's legacy recording, that recording becomes unplayable for the victim too, because the check fails closed.
  - An orphaned legacy file (victim's session row deleted, file still in storage) could still be signed for an attacker who had poisoned a row before the fix.
  - Mitigation: a one-off read-only scan for `sessions.video_url` values outside `pitches/` or shared across users (needs approval to run).
- **Outstanding legacy founder tokens** remain valid until they expire (up to 30 days). That's intended. Rotate `JWT_SECRET` if you want them gone (credential rotation was not approved).
- **No org login lockout.** Organizations have only the per-IP, in-memory rate limiter. Per-account lockout needs columns.
- **Not in scope, still open from the audit:** client-supplied transcript used for scoring (M4), JWT in the WebSocket query string (M5), and per-instance rate limits (M3).
- **AWS read-only checks not performed:** the local AWS CLI session had expired (`aws login` needed). Lambda environment variable names and IAM policies are still unconfirmed.
- **`.gitignore`:** the `Docs` entry ignores `docs/` on this case-insensitive checkout. This report was force-added; the Phase One audit documents remain uncommitted.

## Deployment notes (when approved)

- Deploy the backend to **both** Render and Lambda together. The token format is backward compatible in both directions, but the org lockdown and the resume fix only protect the instance they're deployed on.
- No environment, secret, schema or frontend change is required to deploy.
