# deploy/

One-time AWS setup plus the deploy script for the Lambda deployment model
(decided 2026-09-26).

## Files

- **`SETUP.md`** — the exact one-time AWS console/CLI steps to do before the
  first deploy: ECR repo, Lambda function from container image (arm64, 15-min
  timeout, 1024 MB), all Lambda env vars (required vs optional), the Function
  URL (Auth type NONE — and why that's safe), the private S3 bucket,
  the CloudFront distribution with SPA fallback, the minimal IAM deploy
  policy, and Supabase keys + `supabase db push`.
- **`deploy.sh`** — the deploy script (bash + AWS CLI). See below.

## Deploy flow

```
deploy.sh
  │
  ├─ 1. docker buildx build --platform linux/arm64  (Graviton; matches the
  │      Lambda function's arm64 architecture) from finance-backend/sync-service/
  │      → push to ECR as :latest and :<git-sha>
  ├─ 2. aws lambda update-function-code  → function runs the new image
  ├─ 3. aws lambda wait function-updated (fail fast if the update breaks)
  ├─ 4. read the Function URL via get-function-url-config
  ├─ 5. build web/ with VITE_BACKEND_URL=<Function URL>,
  │      VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY from env
  │      (Vite bakes these in at build time — changing them needs a rebuild)
  ├─ 6. aws s3 sync web/dist/ s3://$S3_BUCKET --delete
  └─ 7. CloudFront invalidation /*  (so the new index.html/assets go live)
```

Invoke it with the required env vars (see `deploy.sh` header and
`SETUP.md` step 9):

```bash
S3_BUCKET=... CLOUDFRONT_DIST_ID=... \
VITE_SUPABASE_URL=... VITE_SUPABASE_PUBLISHABLE_KEY=... \
./deploy/deploy.sh
```

`AWS_REGION` (default `us-east-1`), `ECR_REPO` (default `budget-api`), and
`LAMBDA_FUNCTION` (default `budget-api`) can be overridden the same way.

## Rollback

Every build is pushed with two tags: `:latest` and `:<git-sha>`. If a deploy
misbehaves, point the function back at the previous image:

```bash
aws lambda update-function-code --region us-east-1 \
  --function-name budget-api \
  --image-uri <account>.dkr.ecr.us-east-1.amazonaws.com/budget-api:<previous-sha>
```

List past tags with
`aws ecr list-images --repository-name budget-api --region us-east-1`.
If the bad deploy also shipped a broken frontend, rebuild web/ from the
previous commit (or just re-run `deploy.sh` after checking out the old
commit) — the `/*` invalidation makes the rollback live within a minute or two.

## Logs

- **Backend (Lambda):** CloudWatch Logs → log group `/aws/lambda/budget-api`
  (replace `budget-api` with your function name). From the CLI:
  ```bash
  aws logs tail /aws/lambda/budget-api --follow --region us-east-1
  ```
  Set `LOG_FORMAT=json` on the function (SETUP.md step 3) for structured logs.
- **Frontend:** browser devtools console — it's a static site, there are no
  server logs. API call failures usually mean `WEB_ORIGINS` is missing the
  CloudFront origin (CORS errors) or the Function URL changed without a
  frontend rebuild (`VITE_BACKEND_URL` is baked in at build time).
