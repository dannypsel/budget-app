# One-time AWS setup

Do these steps once, in order, before running `deploy.sh` for the first time.
After setup, every deploy is just:

```bash
S3_BUCKET=<your bucket> CLOUDFRONT_DIST_ID=<your distribution id> \
VITE_SUPABASE_URL=https://<your-project>.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=<your-publishable-key> \
./deploy/deploy.sh
```

**Prerequisites on your machine:** an AWS account, AWS CLI v2 installed and
configured (`aws configure` — needs an access key, or use `aws configure sso`),
Docker with buildx (`docker buildx version` should print a version), and
Node.js 20+ (`node --version`). Run `npm install` inside `web/` once.

**Prerequisites elsewhere:** a Supabase project (free tier). You'll need three
values from it — where to find them is in step 8.

Costs: everything here sits in AWS free-tier territory for personal use —
Lambda's free tier is 1M requests + 400,000 GB-seconds of compute per month,
ECR stores one small image, S3/CloudFront serve a few MB. Expect ~$0/month.

---

## 1. Create the ECR container-image repository

ECR (Elastic Container Registry) is AWS's private Docker image storage. The
deploy script pushes the backend image here, and Lambda pulls it from here.

```bash
aws ecr create-repository --repository-name budget-api --region us-east-1
```

(Console alternative: ECR → Repositories → Create repository, name
`budget-api`, leave the rest default.)

## 2. Create the Lambda function from the container image

Lambda runs the FastAPI backend. We use a **container image** (not a zip file)
because the backend has heavy Python dependencies (Plaid SDK, ML-adjacent
libs) that are easier to ship in a Docker image.

1. Go to **Lambda → Functions → Create function**.
2. Select **Container image** (not "Author from scratch").
3. Function name: `budget-api`.
4. Container image URI: click **Browse images**, pick the `budget-api`
   repository and the `latest` image. No image exists yet on first setup, so
   push one first: after step 1, run `deploy.sh` — it will fail at the
   "updating Lambda" step because the function doesn't exist yet, which is
   fine and expected. Come back here, create the function from the image you
   just pushed, then finish steps 3–8 and re-run `deploy.sh` end to end.
5. **Architecture: arm64.** This is AWS Graviton (ARM chips) — about 20%
   cheaper per GB-second than x86_64, and the deploy script builds the image
   for `linux/arm64`. The image architecture **must match** the function
   architecture or the function won't start.
6. Create the function.
7. Go to **Configuration → General configuration → Edit**:
   - **Timeout: 15 min 0 sec.** This is Lambda's maximum. A manual refresh
     syncs every bank and then runs AI categorization; large histories take
     minutes, and Lambda kills the function when the timeout hits.
   - **Memory: 1024 MB.** Headroom for the Plaid sync + AI categorization
     pipeline running in one process. Lambda bills per GB-second, but 1024 MB
     × a few minutes of personal-use syncs is far below the 400,000 GB-second
     monthly free tier.
   - Save.

## 3. Attach the Lambda environment variables

Lambda → Functions → `budget-api` → **Configuration → Environment variables →
Edit**. Add each of these (copy values from your Supabase dashboard and Plaid
dashboard; generation commands are given where needed).

**Required:**

| Variable | Value / how to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API → Project URL (e.g. `https://xyz.supabase.co`) |
| `SUPABASE_SECRET_KEY` | Same page → **secret** key (`sb_secret_...` — never put this in the frontend) |
| `CREDENTIALS_ENC_KEY` | Fernet key encrypting Plaid tokens at rest. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `WEB_ORIGINS` | Comma-separated list of origins allowed to call the API from a browser. **Must include your CloudFront origin** (e.g. `https://d1234abcdef.cloudfront.net`) — that's where the web app lives. Add `http://localhost:5173` too if you want local `vite dev` to keep working. |
| `PLAID_CLIENT_ID` | Plaid dashboard → API → Keys |
| `PLAID_SECRET` | Plaid dashboard → API → Keys (the secret for the environment below) |
| `PLAID_ENV` | `sandbox` for testing, `development` for real banks (free, up to 100 live Items), `production` when you go live |
| `PLAID_REDIRECT_URI` | `<your Function URL from step 4>/link` (e.g. `https://abc123.lambda-url.us-east-1.on.aws/link`). **Why:** OAuth banks (Chase, Bank of America, …) bounce the browser back to this URL after you log in; the backend's `/link` page resumes the flow from there. You must also allowlist this exact URL in the Plaid dashboard → API → **Allowed redirect URIs**, or Plaid will refuse to redirect. |

**Optional but recommended:**

| Variable | Value |
|---|---|
| `AI_CLASSIFIER_PROVIDER` | `jev` (default if unset), `gemini`, or `off` |
| `JEV_API_KEY` | TypeSafe Jev API key (get one at https://typesafe.ai). Without it, AI categorization is skipped gracefully |
| `JEV_MODEL` | Model alias (default `jev-latest`); usually leave unset |
| `AI_CONFIDENCE_THRESHOLD` | `0.7` default; below this, verdicts go to the review queue |
| `BRAVE_API_KEY` | Brave Search key (free tier) for merchant enrichment on low-confidence verdicts; unset = skipped |
| `AI_MAX_BRAVE_LOOKUPS_PER_RUN` | Safety rail for the Lambda 15-min cap: max Brave merchant lookups per refresh (default 10). Lower it if refreshes ever time out. |
| `AI_CATEGORIZE_TIME_BUDGET_S` | Safety rail for the Lambda 15-min cap: overall AI-categorization time budget in seconds per refresh (default 300). Transactions past the budget go to the review queue. |
| `LOG_FORMAT` | `json` — structured logs, much easier to read in CloudWatch |
| `PYTHONDONTWRITEBYTECODE` | `1` |
| `PYTHONUNBUFFERED` | `1` |

**Not needed anymore (never set these):**
- `TRIGGER_SECRET` — the 24/7 scheduler was removed along with the
  `/internal/*` endpoints (deleted; they answer 404 if poked).
- `PLAID_WEBHOOK_URL` — Plaid webhooks were removed (manual refresh only);
  `POST /webhook/plaid` is deleted (404 if poked). Do not register a webhook
  URL in the Plaid dashboard.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — the
  background email digest was dropped with the scheduler; in-app notifications
  are evaluated at refresh time instead.

## 4. Expose the backend over HTTPS (API Gateway HTTP API)

> **Do not use a Lambda Function URL in this AWS account.** Function URLs
> return `403 AccessDeniedException` on every invocation here, even with the
> correct `lambda:InvokeFunctionUrl` resource policy (verified in `us-east-1`
> and `us-west-2` with trivial test functions on 2026-09-27). The backend is
> therefore exposed through an **API Gateway HTTP API** instead.
> `VITE_BACKEND_URL` points at the API Gateway URL. If Function URLs start
> working again, the Function URL steps below still apply.

The API Gateway URL is the public HTTPS address of the backend. The frontend
is built with this URL baked in (`VITE_BACKEND_URL`).

Create it (CLI; run once):

```bash
AWS_REGION=us-east-1
# 1. HTTP API with $default stage
API_ID=$(aws apigatewayv2 create-api --name budget-api --protocol-type HTTP \
  --region $AWS_REGION --query ApiId --output text)
# 2. Lambda proxy integration
LAMBDA_ARN="arn:aws:lambda:${AWS_REGION}:656192943270:function:budget-api"
INT_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
  --integration-type AWS_PROXY --integration-uri "$LAMBDA_ARN" \
  --payload-format-version 2.0 --region $AWS_REGION \
  --query IntegrationId --output text)
# 3. Catch-all route
aws apigatewayv2 create-route --api-id "$API_ID" --route-key '$default' \
  --target "integrations/${INT_ID}" --region $AWS_REGION >/dev/null
# 4. $default stage (auto-deploy)
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' \
  --auto-deploy --region $AWS_REGION >/dev/null
# 5. Let API Gateway invoke the function
aws lambda add-permission --function-name budget-api --statement-id apigw \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:656192943270:${API_ID}/*" \
  --region $AWS_REGION >/dev/null
echo "Backend URL: https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com"
```

Then go back to step 3 and set `PLAID_REDIRECT_URI` to `<that URL>/link`.

**Why Auth type NONE is safe — the app has its own auth.** "Auth type NONE"
only means *AWS* doesn't check credentials; the app checks them itself.
Verified against `finance-backend/sync-service/api.py`:

- Every endpoint that touches data requires the user's **Supabase JWT** in the
  `Authorization: Bearer …` header, verified against Supabase Auth on every
  call. No valid token → `401`. Your financial data is not reachable without
  being signed in.
- The public exceptions are all non-data: `GET /health` returns only
  `{"status":"ok"}`; `GET /link` and `GET /onboard` are static HTML shells —
  the Plaid calls they make go to `/link/prepare`, `/link/exchange`, and
  `/link/claim`, which all require the JWT. (`POST /webhook/plaid` and
  `POST /internal/*` were deleted entirely — they answer 404.)

AWS_IAM auth would break the browser app (browsers can't sign AWS requests),
so NONE is the correct choice here.

## 5. Create the S3 bucket for the frontend

S3 stores the built static files (`index.html`, JS, CSS). The bucket stays
**private** — CloudFront reads it through an Origin Access Control (OAC), so
nobody accesses S3 directly.

```bash
aws s3api create-bucket --bucket <your-unique-bucket-name> --region us-east-1
```

- Bucket names are globally unique; pick something like
  `dara-budget-web-2026` (any name works — set `S3_BUCKET` to it at deploy time).
- Leave **Block all public access ON** (the default). Do **not** enable
  "Static website hosting" — CloudFront + OAC replaces it.
- (Console alternative: S3 → Create bucket, keep defaults.)

## 6. Create the CloudFront distribution

CloudFront is AWS's CDN: it serves the web app over HTTPS (required for the
PWA/installable app) from edge locations worldwide.

1. Go to **CloudFront → Create distribution**.
2. **Origin domain:** select your S3 bucket from the list. When prompted,
   choose **Origin access control (OAC)** and let it update the bucket policy
   ("Yes, update the bucket policy"). This is what lets CloudFront read the
   private bucket.
3. **Default root object:** `index.html`.
4. **Viewer protocol policy:** Redirect HTTP to HTTPS.
5. **Custom error responses** (this is the SPA fallback — without it,
   refreshing on `/transactions` or sharing a deep link gives an error page):
   - Add: HTTP error code **403** → Customize error response: Yes →
     Response page path: `/index.html` → HTTP response code: **200**.
   - Add the same for **404** → `/index.html` → **200**.
   (S3 returns 403 for missing "folders" when accessed via OAC, hence both.)
6. **Caching:** the default cache behavior should **not** cache aggressively —
   use the `CachingDisabled` managed policy (or a short TTL) so `index.html`
   is never stale after a deploy. Then add a second cache behavior:
   - Path pattern: `/assets/*`, cache policy `CachingOptimized`. Vite emits
     hashed filenames (`assets/index-a1b2c3.js`), so these are safe to cache
     for a year; a new deploy produces new filenames.
7. Create the distribution and note its **domain name**
   (`d1234abcdef.cloudfront.net`). That's the value that must be in the
   Lambda `WEB_ORIGINS` (step 3) and the URL you'll open in the browser.
   (Deployment takes a few minutes; status changes from "In Progress" to
   "Deployed".)

## 7. IAM permissions for deploys

The deploy script needs AWS permissions. Create a **dedicated IAM user**
(e.g. `budget-deploy`) used only for this — not your root credentials.

1. **IAM → Users → Create user**, name `budget-deploy`.
2. Attach an inline policy (**Permissions → Add permissions → Create inline
   policy → JSON**) with the JSON below, replacing `YOUR-BUCKET`,
   `YOUR-ACCOUNT-ID`, and `YOUR-DIST-ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRPush",
      "Effect": "Allow",
      "Action": ["ecr:*"],
      "Resource": "arn:aws:ecr:us-east-1:YOUR-ACCOUNT-ID:repository/budget-api"
    },
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Sid": "LambdaDeploy",
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionUrlConfig",
        "lambda:WaitFunctionUpdated"
      ],
      "Resource": "arn:aws:lambda:us-east-1:YOUR-ACCOUNT-ID:function:budget-api"
    },
    {
      "Sid": "S3WebBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Sid": "S3WebObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::YOUR-ACCOUNT-ID:distribution/YOUR-DIST-ID"
    }
  ]
}
```

3. Create an **access key** for the user (Security credentials → Create access
   key → "Command Line Interface (CLI)") and configure it locally:
   `aws configure` (or store under a named profile and add
   `AWS_PROFILE=...` when running the script). The deploy script needs no
   other permissions.

## 8. Supabase: keys and migrations

1. **Keys** — Supabase dashboard → your project → **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL` (Lambda env, step 3) and
     `VITE_SUPABASE_URL` (deploy-time env for `deploy.sh`).
   - **publishable key** (`sb_publishable_...`) → `VITE_SUPABASE_PUBLISHABLE_KEY` (deploy-time env). Safe
     for the browser — it's gated by Row Level Security.
   - **secret key** (`sb_secret_...`) → `SUPABASE_SECRET_KEY` (Lambda env
     only — full database access, never in the frontend).
2. **Migrations** — unchanged from local dev. From the repo, link the project
   once and push:
   ```bash
   cd finance-backend
   supabase link --project-ref <your-project-ref>   # ref is in the Project URL: https://<ref>.supabase.co
   supabase db push
   ```
   (`db push` needs the database password — Project Settings → Database →
   you set it at project creation; reset it there if lost.)

## 9. First deploy

```bash
S3_BUCKET=<bucket from step 5> \
CLOUDFRONT_DIST_ID=<id from step 6> \
VITE_SUPABASE_URL=https://<ref>.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=<your-publishable-key> \
./deploy/deploy.sh
```

Then open the CloudFront domain (`https://d1234abcdef.cloudfront.net`) and
sign in. If the API calls fail, the usual culprits are: `WEB_ORIGINS` missing
the CloudFront origin (browser blocks the call — check the console for CORS
errors), or `PLAID_REDIRECT_URI` not allowlisted in the Plaid dashboard.
