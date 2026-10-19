# Deployment

Two environments, two branches. Nobody needs the AWS console to ship code.

| Branch | Environment | API (Lambda) | Live-pitch server (Render) | Website (Vercel) | Database (Supabase) |
|---|---|---|---|---|---|
| `dev` | **DEV**, for testing | `pitchnest-dev-api` in account `639324724698`, at `https://l5isutzx18.execute-api.eu-west-2.amazonaws.com` | DEV service on branch `dev` | `dev` branch preview: `https://pitchnestapp-git-dev-immanexs-projects.vercel.app` | `ueqwulsbbcvnduhepimh` |
| `main` | **PROD**, live | `pitchnest-prod-api` alias `live` in account `415081251151`, at `https://mkrkiditq5.execute-api.eu-west-2.amazonaws.com` | PROD service "PitchNest-Backend" on branch `main` | `https://www.pitchnest.app` | `oyztdulmyuklorbudcgb` |

## Day to day
1. Branch from `dev`, open a pull request into `dev`, merge. DEV updates by itself: API, live-pitch server and website.
2. Test on the DEV website.
3. Open a pull request from `dev` into `main`, and merge it. PROD updates by itself.

**Database changes are never automatic.** Apply a migration to DEV Supabase before merging into `dev`, and to PROD Supabase before merging into `main`.

**A change that touches both repos:** merge the backend first and wait for its run to finish, then merge the frontend.

## What `.github/workflows/deploy-api.yml` does
Every push to `dev` or `main` (and every pull request into them):
1. Type-checks, lints the release script, runs the tests and the migration checks, then builds and verifies one Lambda package. Pull requests stop here.
2. Ships that exact package with `scripts/release-lambda.sh`:
   - **PROD:** publishes an immutable version and smoke-tests it directly (`/api/health`, `/api/public/businesses`). It moves `live` only if both pass, then checks the public API, and moves `live` back if that check fails.
   - **DEV:** the DEV API invokes `$LATEST`, so the upload is live immediately. It's smoke-tested and checked the same way; a failure fails the run, and you fix it by pushing a corrected commit.
3. Calls that environment's Render deploy hook for the same commit. Render's own auto-deploy stays **off**, so it never deploys a commit that failed.

AWS access uses GitHub OIDC; no AWS keys are stored anywhere. The DEV role trusts only branch `dev` of this repository, and the PROD role only `main`.

## Rolling back PROD
- **API:** Actions → **Roll back API** → **Run workflow** on `main`, and enter the version from the PROD run's summary. It takes effect in seconds.
- **Everything:** use **Revert** on the merged pull request into `main` and merge the revert. The workflow redeploys the API and Render.
- **Render only:** dashboard → **Events** → previous deploy → **Rollback**.
- **Website:** Vercel → **Deployments** → previous production deployment → **Instant Rollback**.

## One-time setup
### AWS: in each account
Each account needs:
- the GitHub OIDC identity provider: `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`
- one deploy role, as follows:

| Account | Role | Trusted branch | Function |
|---|---|---|---|
| DEV `639324724698` | `PitchNest-Dev-GitHubActionsRole` (the existing role, reduced to the policy below) | `dev` | `pitchnest-dev-api` |
| PROD `415081251151` | `pitchnest-prod-api-deploy` | `main` | `pitchnest-prod-api` |

The deploy role must carry **no other policy**. Broad grants such as `lambda:*`, `secretsmanager:*` or `cloudformation:*` would let any workflow on the trusted branch take over the account.

1. **The role's trust policy** must be exactly:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:PitchNest-Lab@288660191/PitchNest-Backend@1384711444:ref:refs/heads/<BRANCH>"
         }
       }
     }]
   }
   ```
   GitHub identifies this repository by its owner and repository IDs (`@288660191`, `@1384711444`). The IAM console's GitHub fields generate the older `repo:PitchNest-Lab/PitchNest-Backend:…` form, which AWS refuses, so create the role with **Custom trust policy** and paste the JSON above. If a sign-in is ever refused, the run's **Explain a refused AWS sign-in** annotations show the exact `sub` that GitHub presented.
2. **Its only permissions** are one inline policy:
   - **DEV** (`deploy-pitchnest-dev-api`): `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `lambda:UpdateFunctionCode` and `lambda:InvokeFunction`.
   - **PROD** (`deploy-pitchnest-prod-api`): those four, plus `lambda:PublishVersion`, `lambda:GetAlias` and `lambda:UpdateAlias`.

   In both, `Resource` is the function's ARN and the same ARN followed by `:*`.

**DEV only:**
- The DEV function reads nine secrets from `/pitchnest/dev/`:
  - `JWT_SECRET`
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `RESEND_API_KEY`
  - `GOOGLE_CLIENT_ID`
  - `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`

  Its execution role (`PitchNest-Dev-LambdaExecutionRole`) has an inline policy, `read-pitchnest-dev-parameters`, that allows `ssm:GetParameters` on `arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/*`.
- `JWT_SECRET` must be at least 32 bytes, and the same value as the DEV Render service's `JWT_SECRET`.
- The function's environment variables:
  - `NODE_ENV=development`, `PITCHNEST_ENV=dev`
  - `ALLOWED_ORIGIN`, `CLIENT_URL` and `APP_BASE_URL` set to the DEV website.

### Render
- **PROD:** service "PitchNest-Backend" (branch `main`).
- **DEV:** a second web service on branch `dev`, with DEV values. Use the same build (`npm install; npm run build`) and start (`npm start`) commands as PROD. Its `JWT_SECRET` must equal `/pitchnest/dev/JWT_SECRET`.
- **On both:** keep **Auto-Deploy** off, and copy the **Deploy Hook** from Settings.

### GitHub (this repository → Settings → Secrets and variables → Actions)
| Secret | Value |
|---|---|
| `AWS_DEV_ROLE_ARN` | `arn:aws:iam::639324724698:role/PitchNest-Dev-GitHubActionsRole` |
| `AWS_PROD_ROLE_ARN` | `arn:aws:iam::415081251151:role/pitchnest-prod-api-deploy` |
| `RENDER_DEV_DEPLOY_HOOK` | the DEV service's deploy hook |
| `RENDER_PROD_DEPLOY_HOOK` | the PROD service's deploy hook |

Treat the deploy hooks as secrets: anyone who has one can trigger a deploy.

### Vercel (PitchNest-Frontend)
Under **Environment Variables**, for **Preview** (branch `dev`):
- `VITE_API_URL` = `https://l5isutzx18.execute-api.eu-west-2.amazonaws.com`
- `VITE_WS_BACKEND_URL` = `wss://<DEV Render service>.onrender.com/ws`
- `VITE_GOOGLE_CLIENT_ID` = the DEV Google client ID

Without them, a preview build talks to PROD. The website's Content-Security-Policy must also allow the DEV API, the DEV WebSocket and the DEV Supabase project. The Google OAuth client must list the DEV website as an authorized JavaScript origin.

### Recommended
Protect `main` and `dev` (Settings → Rules → Rulesets): require a pull request and the **Test and package** check.
