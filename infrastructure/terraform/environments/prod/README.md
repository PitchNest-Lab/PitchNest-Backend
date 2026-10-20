# PitchNest PROD — REST API infrastructure (Terraform)

- **Account:** `415081251151` (PROD). DEV is `639324724698` and is **not** managed here.
- **Region:** `eu-west-2`
- **CLI profile:** `pitchnest-prod`
- **Status:** live since 18 October 2026. The frontend routes production REST traffic here; Lambda alias `live` pointed to version 4 at that release, with version 3 retained as the rollback. Treat version numbers as release records, not permanent configuration.

## What this creates

| Resource | Purpose |
|---|---|
| `aws_iam_role` `pitchnest-prod-api-execution` + inline policy | **Owned**, least-privilege execution role: write to its own log group; `ssm:GetParameters` on the exact `/pitchnest/prod/<NAME>` ARNs; optional `kms:Decrypt` restricted to SSM (`kms:ViaService`) |
| `aws_cloudwatch_log_group` `/aws/lambda/pitchnest-prod-api` | Function logs: JSON format, 90-day retention |
| `aws_lambda_function` `pitchnest-prod-api` | nodejs22.x, 512 MB, 30 s, `publish = true`. Created with a **placeholder** that answers 503 |
| `aws_lambda_alias` `live` | The only thing API Gateway invokes. A reviewed manual release moves it; operators move it back to roll back |
| `aws_apigatewayv2_*` `pitchnest-prod-api` | HTTP API with `$default` route → **alias** integration (not `$LATEST`); stage throttling (50 rps, burst 100); structured JSON access logs. The public endpoint is enabled for the live service; setting `api_public_endpoint_enabled = false` is an emergency shutdown. |
| `aws_cloudwatch_log_group` `/aws/apigateway/pitchnest-prod-api/access` | Access logs: 90-day retention. No headers, query strings or bodies, so tokens never reach the log |
| `aws_sns_topic` `pitchnest-prod-api-alarms` + `aws_sns_topic_policy` + optional email subscriptions | Alarm notifications. **No SSE**: `alias/aws/sns` can't be used, because CloudWatch can't use the AWS-managed SNS key. Protected by a topic policy: only this account's `pitchnest-prod-api-*` alarms may publish; TLS required; administration delegated to the account's IAM |
| 5 × `aws_cloudwatch_metric_alarm` | Lambda Errors, Throttles and p95 Duration (alias-level); API 5xx (threshold `api_5xx_threshold`, default 20 per 5 min) and p95 Latency. They evaluate continuously. The repository default leaves notification actions off; confirm subscriptions and delivery before turning them on. |

Not created here, by design:
- **The state bucket.** It's a prerequisite (below).
- **SSM parameters.** Secret values are created out of band and never pass through Terraform or its state.
- **A deployment (OIDC) role.** That's the next step, with the pipeline.
- **A custom domain.**

## Ownership model

| Owner | Owns |
|---|---|
| Terraform | Infrastructure and **non-secret** configuration: `NODE_ENV=production`, `PITCHNEST_ENV=prod`, `CLIENT_URL`, `ALLOWED_ORIGIN`, `APP_BASE_URL`, plus `extra_environment_variables`. A validation rule rejects secret-looking variable names |
| Release operator | **Code**: upload a reviewed artifact, publish a version, smoke-test it, move `live`. Terraform ignores the code fields and the alias pointer after creation |
| Operators | **Secret values** in SSM (`/pitchnest/prod/*`), and rollbacks |

**A Terraform configuration change publishes a new version but does not move `live`.** It only reaches users when an operator moves the alias. That's intentional: there are no silent code releases.

## Infrastructure prerequisites and invariants

### 1. State bucket requirements (PROD account)

Create the bucket **in the PROD account**, separately from DEV's `pitchnest-terraform-state-639324724698`.

| Setting | Requirement |
|---|---|
| Name | `pitchnest-terraform-state-415081251151` (referenced in `backend.tf`) |
| Region | `eu-west-2` |
| Versioning | **Enabled**, so state can be recovered |
| Encryption | Default SSE-KMS (a customer-managed key is preferred) with Bucket Key, or SSE-S3 at minimum. The backend also sets `encrypt = true` |
| Public access | **All four** Block Public Access settings on |
| Object ownership | `BucketOwnerEnforced` (ACLs disabled) |
| Bucket policy | Deny `aws:SecureTransport = false`. Deny principals outside account `415081251151` |
| Locking | **Native S3 lockfile** (`use_lockfile = true`, Terraform ≥ 1.10). **No DynamoDB table.** The runner needs `s3:PutObject` and `s3:DeleteObject` on `prod/pitchnest-api/terraform.tfstate.tflock` |
| Lifecycle | Expire non-current versions after 90 days or more (optional). Never expire current state |
| Access | `s3:ListBucket` on the bucket; `s3:GetObject` and `s3:PutObject` on the state key; `s3:PutObject` and `s3:DeleteObject` on the `.tflock` key. Restrict to admins and the future deploy role |

Reference commands. These are **not run**, and need approval and the PROD admin profile:

```bash
B=pitchnest-terraform-state-415081251151; P="--profile pitchnest-prod --region eu-west-2"
aws s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=eu-west-2 $P
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled $P
aws s3api put-public-access-block --bucket $B $P --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket $B $P \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-encryption --bucket $B $P --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
# then attach a bucket policy that denies non-TLS access and non-PROD-account principals
```

### 2. SSM parameters (`/pitchnest/prod/`)

Create these as **SecureString**. Take every value from its **production source** (the provider dashboard or Render), **never from DEV SSM**:

`JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`

- **`JWT_SECRET` must EQUAL Render's production secret** while Live Pitch runs on Render. The Render WebSocket validates tokens issued by this Lambda, and existing users' tokens must keep working. A different value breaks Live Pitch and logs everyone out.

- **These must match `PARAMETER_NAMES` in `src/config/loadAwsParameters.ts`.** The loader fails closed if any is missing, which means every request returns an error.
- **Extend `ssm_parameter_names` and the loader together** (for example `FLW_SECRET_KEY` and `FLW_WEBHOOK_HASH` when billing is enabled).
- **The Supabase values must point at `PitchNest-Live`** (`oyztdulmyuklorbudcgb`). Verified on 2026-10-11 by project reference only; no values were displayed.
- **Flutterwave:** `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH` and `FLW_PUBLIC_KEY` exist in PROD SSM but are **deliberately not readable by the Lambda** (see *Billing: prepared but off*). `FLW_PUBLIC_KEY` is unused by both the backend and the frontend, which uses hosted checkout.
- **If you use a customer-managed KMS key,** pass `ssm_kms_key_arn`.
- **The API version is non-secret.** Terraform sets `AZURE_OPENAI_API_VERSION` (`azure_openai_api_version`, default `2026-07-09`); the loader doesn't read it from SSM.

### 3. Account checks (read-only)

```bash
aws sts get-caller-identity --profile pitchnest-prod            # must be 415081251151
aws lambda get-account-settings --profile pitchnest-prod --region eu-west-2 \
  --query 'AccountLimit.{Concurrent:ConcurrentExecutions,Unreserved:UnreservedConcurrentExecutions}'
```

**Concurrency:** new accounts may have a concurrency quota of only **10**. Keep `reserved_concurrency = -1` until a quota increase has been granted; Lambda refuses a reservation that leaves fewer than 10 unreserved.

## Apply sequence (each step needs approval)

```bash
cd infrastructure/terraform/environments/prod
$env:AWS_PROFILE = "pitchnest-prod"        # PowerShell; bash: export AWS_PROFILE=pitchnest-prod
terraform init                              # backend refuses non-PROD credentials
terraform plan -out=prod.tfplan             # review: only PROD resources; check the account guard
terraform apply prod.tfplan
```

After the apply:
1. `curl $(terraform output -raw api_endpoint)/api/health` should return a small `status: ok` response.
2. Confirm the alias still points to the intended immutable version; an infrastructure apply must not move it.
3. Confirm the SNS email subscriptions, if any were configured.

## Live-service safeguards

| Safeguard | Current repository posture |
|---|---|
| `api_public_endpoint_enabled = true` | Matches the live REST API. Changing it to false is an emergency shutdown, not a pre-release default. |
| `alarm_notifications_enabled = false` | Alarms retain state, but notification delivery is not assumed. Confirm the SNS subscriptions and test delivery before enabling actions. |
| Bootstrap placeholder | Used only when Terraform must recreate the function. API Gateway invokes `live`, and releases move that alias only after a qualified-version smoke test. |

Disabling or enabling the default endpoint can need a fresh stage deployment before it takes effect. Verify with `curl`; if needed run `aws apigatewayv2 create-deployment --api-id <id> --stage-name '$default'`.

### Intentional 503s and the API 5xx alarm

The `5xx` metric counts **every** 5xx response, including intentional ones:
- the pre-release placeholder (503 for every request)
- `POST /api/billing/checkout` returning **503 `billing_unavailable`** while Flutterwave isn't configured
- `POST /api/auth/google` returning **503** if `GOOGLE_CLIENT_ID` is missing

The threshold defaults to **20 per 5 minutes** (`api_5xx_threshold`) so occasional intentional 503s don't trigger it. **Lambda Errors** is the primary signal for real failures. Integration timeouts surface as 5xx and as p95 duration or latency.

## Billing: prepared but off

PitchNest is not accepting subscription payments. The existing free trial is unchanged.

| Control | State |
|---|---|
| `BILLING_CHECKOUT_ENABLED` (`billing_checkout_enabled`) | **`"false"`**. Checkout returns 503 `billing_unavailable` even if the keys were loaded |
| Flutterwave keys readable by the Lambda | **No.** They aren't in `ssm_parameter_names`, so IAM denies them; checkout and webhook stay inert |
| Purchasable SKU | **Pro monthly only** (USD 15 for 30 days: `PRO_PLAN_*`). Annual and Prep requests return 400 `plan_not_available` |
| `extra_environment_variables` | Can't override any managed key (validation) |

Enabling billing later requires **all** of the following, each reviewed:
1. Supabase: `REVOKE EXECUTE` on `grant_pro_access` from `PUBLIC`/`anon`/`authenticated`.
2. The webhook fix: grant before responding (readiness P0-2).
3. A Flutterwave sandbox end-to-end test on DEV.
4. The loader and `ssm_parameter_names` both gaining `FLW_SECRET_KEY` and `FLW_WEBHOOK_HASH`.
5. `billing_checkout_enabled = true`.
6. Repointing the Flutterwave webhook URL.

## Releasing code (pipeline or manual, after approval)

Build and verify the package from the repository root. Both run locally with no AWS access:

```bash
npm run build:lambda:prod     # dist/pitchnest-api-prod.zip + .manifest.json (sha256 = Lambda CodeSha256)
npm run verify:lambda:prod    # extracts the zip outside the repo; real handler + fake SSM; PDF generation + extraction
```

```bash
F=pitchnest-prod-api; P="--profile pitchnest-prod --region eu-west-2"
# 1. Build + verify (above) from a reviewed commit; keep the manifest with the release record
# 2. Upload code and publish an immutable version (live traffic unaffected)
V=$(aws lambda update-function-code --function-name $F --zip-file fileb://dist/pitchnest-api-prod.zip --publish $P --query Version --output text)
aws lambda wait function-updated --function-name $F $P
# 3. Smoke-test THAT version directly (live traffic is unaffected)
aws lambda invoke --function-name $F --qualifier $V $P --cli-binary-format raw-in-base64-out \
  --payload '{"version":"2.0","routeKey":"$default","rawPath":"/api/health","rawQueryString":"","headers":{"host":"smoke"},"requestContext":{"http":{"method":"GET","path":"/api/health","protocol":"HTTP/1.1","sourceIp":"127.0.0.1","userAgent":"smoke"},"stage":"$default"},"isBase64Encoded":false}' out.json
# 4. Record the current live version (your rollback target), then promote
PREV=$(aws lambda get-alias --function-name $F --name live $P --query FunctionVersion --output text)
aws lambda update-alias --function-name $F --name live --function-version $V $P
```

### Verifying alarm delivery (after notifications are enabled)

```bash
aws cloudwatch set-alarm-state --alarm-name pitchnest-prod-api-lambda-throttles --state-value ALARM   --state-reason "notification test" --profile pitchnest-prod --region eu-west-2
aws cloudwatch describe-alarm-history --alarm-name pitchnest-prod-api-lambda-throttles   --history-item-type Action --max-records 3 --profile pitchnest-prod --region eu-west-2
```

The history must show `Successfully executed action`.

## Rollback (seconds, no rebuild)

```bash
aws lambda update-alias --function-name pitchnest-prod-api --name live --function-version <PREV> \
  --profile pitchnest-prod --region eu-west-2
```

- Versions are immutable, so every earlier release stays available.
- An infrastructure rollback means reverting the Terraform change and re-applying. State versioning keeps prior state recoverable.

## DEV impact

**None.**
- `environments/dev` and the shared `modules/lambda` and `modules/api_gateway` are **unchanged**.
- PROD uses the new modules `lambda_service`, `http_api` and `observability`.
- Separate backend, separate state key, separate account, and an account guard on both backend and provider.
