# Deployment

Merging to `main` releases to production. Nobody needs to open the AWS console to ship code.

| Part | Host | Deploys when |
|---|---|---|
| Website | Vercel project `pitchnestapp` | Automatically, on every push to `main` of PitchNest-Frontend |
| REST API | AWS Lambda `pitchnest-prod-api`, alias `live` | Automatically, on every push to `main` of this repository (`.github/workflows/deploy-api.yml`) |
| Live-pitch server | Render "PitchNest-Backend" | Triggered by the same workflow once the API release succeeds. Render's own auto-deploy stays **off**, so it never deploys a commit that failed. |
| Database | Supabase | **Never automatically.** Apply new migrations in Supabase before merging code that needs them. |

## What the workflow does
1. Type-checks, runs the tests and the migration checks, then builds and verifies the Lambda package. Pull requests stop here.
2. Uploads the package and publishes an immutable Lambda version.
3. Smoke-tests that version directly (`/api/health`, `/api/public/businesses`) before any user reaches it. If either check fails, `live` doesn't move.
4. Moves `live` to the new version, then checks the public API. If that check fails, it moves `live` back.
5. Calls Render's deploy hook for the same commit.

The run summary names the new version and the one it replaced.

**A change that needs both repos:** merge the backend first, wait for its run to finish, then merge the frontend.

## Rolling back
- **API:** Actions → **Roll back API** → **Run workflow** (branch `main`), and enter the previous version from the deploy run's summary. It takes effect in seconds.
- **Everything:** use **Revert** on the merged pull request and merge the revert. The workflow redeploys the API and Render from it.
- **Render only:** dashboard → **Events** → previous deploy → **Rollback**.
- **Website:** Vercel → **Deployments** → previous deployment → **Instant Rollback**.

## One-time setup
### AWS (PROD account `415081251151`, region eu-west-2)
1. **IAM → Identity providers → Add provider:** OpenID Connect, provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. **IAM → Roles → Create role → Web identity:**
   - provider `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`
   - GitHub organization `PitchNest-Lab`, repository `PitchNest-Backend`, branch `main`
   - no managed policies; role name `pitchnest-prod-api-deploy`

   Its trust policy must be:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::415081251151:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": { "token.actions.githubusercontent.com:sub": "repo:PitchNest-Lab/PitchNest-Backend:ref:refs/heads/main" }
       }
     }]
   }
   ```
   Only workflows running on `main` of this repository can use the role. Pull requests, forks and other branches can't.
3. **Inline policy** `deploy-pitchnest-prod-api` on that role:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "ReleasePitchnestProdApi",
       "Effect": "Allow",
       "Action": [
         "lambda:GetFunction",
         "lambda:GetFunctionConfiguration",
         "lambda:UpdateFunctionCode",
         "lambda:PublishVersion",
         "lambda:InvokeFunction",
         "lambda:GetAlias",
         "lambda:UpdateAlias"
       ],
       "Resource": [
         "arn:aws:lambda:eu-west-2:415081251151:function:pitchnest-prod-api",
         "arn:aws:lambda:eu-west-2:415081251151:function:pitchnest-prod-api:*"
       ]
     }]
   }
   ```
   It can only ship code to this one function and move its alias. It can't change configuration, secrets or any other resource.

### GitHub (this repository → Settings → Secrets and variables → Actions → New repository secret)
- `AWS_DEPLOY_ROLE_ARN`: the role's ARN, `arn:aws:iam::415081251151:role/pitchnest-prod-api-deploy`.
- `RENDER_DEPLOY_HOOK_URL`: Render → PitchNest-Backend → **Settings** → **Deploy Hook**. Treat it as a secret: anyone who has it can trigger a deploy.

### Recommended
Protect `main` (Settings → Rules → Rulesets): require a pull request and the **Test and package** check. Merging to `main` is a production release.
