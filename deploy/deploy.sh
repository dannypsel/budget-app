#!/usr/bin/env bash
#
# Deploy the self-hosted budget app:
#   1. Build the FastAPI backend as a container image (linux/arm64) and push to ECR
#   2. Point the Lambda function at the new image
#   3. Build the web frontend with the Lambda Function URL baked in
#   4. Sync the static build to S3 and invalidate CloudFront
#
# Usage:
#   S3_BUCKET=my-bucket CLOUDFRONT_DIST_ID=E123ABC \
#   VITE_SUPABASE_URL=https://xyz.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
#   ./deploy/deploy.sh
#
# Optional overrides: AWS_REGION (default us-east-1), ECR_REPO (default budget-api),
# LAMBDA_FUNCTION (default budget-api).
#
# One-time AWS setup (ECR repo, Lambda function, Function URL, S3 bucket,
# CloudFront distribution, IAM permissions) is documented in deploy/SETUP.md.

set -euo pipefail

# ── Parameters ───────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ECR_REPO:-budget-api}"
LAMBDA_FUNCTION="${LAMBDA_FUNCTION:-budget-api}"
S3_BUCKET="${S3_BUCKET:-}"
CLOUDFRONT_DIST_ID="${CLOUDFRONT_DIST_ID:-}"
VITE_SUPABASE_URL="${VITE_SUPABASE_URL:-}"
VITE_SUPABASE_PUBLISHABLE_KEY="${VITE_SUPABASE_PUBLISHABLE_KEY:-}"

fail() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[ -n "$S3_BUCKET" ]          || fail "S3_BUCKET is not set (the S3 bucket created in SETUP.md step 5)."
[ -n "$CLOUDFRONT_DIST_ID" ] || fail "CLOUDFRONT_DIST_ID is not set (the CloudFront distribution from SETUP.md step 6)."
[ -n "$VITE_SUPABASE_URL" ]  || fail "VITE_SUPABASE_URL is not set (Supabase project URL, e.g. https://xyz.supabase.co)."
[ -n "$VITE_SUPABASE_PUBLISHABLE_KEY" ] || fail "VITE_SUPABASE_PUBLISHABLE_KEY is not set (Supabase publishable key, sb_publishable_...)."

command -v aws    >/dev/null || fail "aws CLI not found — install AWS CLI v2 and run 'aws configure'."
command -v docker >/dev/null || fail "docker not found — install Docker Desktop (or the Docker engine)."
command -v npm    >/dev/null || fail "npm not found — install Node.js 20+."
docker buildx version >/dev/null 2>&1 || fail "docker buildx not available — update Docker."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/finance-backend/sync-service"
WEB_DIR="$REPO_ROOT/web"

# The backend worker owns the Lambda contract: lambda_handler.py exposing
# `handler` (Mangum adapter), and a Dockerfile based on the Lambda python image
# with CMD ["lambda_handler.handler"]. Refuse to deploy a half-finished image.
[ -f "$BACKEND_DIR/lambda_handler.py" ] || fail "$BACKEND_DIR/lambda_handler.py is missing — the backend worker must add it first (contract: handler object named 'handler')."
[ -f "$BACKEND_DIR/Dockerfile" ]        || fail "$BACKEND_DIR/Dockerfile is missing."

step "0/7 — resolving AWS identifiers"
ACCOUNT_ID="$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$ECR_REPO" >/dev/null \
  || fail "ECR repo '$ECR_REPO' not found in $AWS_REGION. Do SETUP.md step 1 first."
if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
else
  SHA="$(date +%Y%m%d%H%M%S)"
  echo "Not a git repo — tagging image with timestamp $SHA instead of a commit SHA."
fi
echo "ECR image: $ECR_URI:$SHA (also :latest)"

step "1/7 — building backend image (linux/arm64)"
# linux/arm64 = AWS Graviton2. Lambda charges per GB-second, and Graviton
# costs ~20% less than x86_64 for the same memory. This MUST match the
# architecture chosen for the Lambda function in SETUP.md step 2.
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" >/dev/null
docker buildx build --platform linux/arm64 \
  -t "$ECR_URI:$SHA" -t "$ECR_URI:latest" \
  --push "$BACKEND_DIR"

step "2/7 — updating Lambda function code"
aws lambda update-function-code --region "$AWS_REGION" \
  --function-name "$LAMBDA_FUNCTION" \
  --image-uri "$ECR_URI:$SHA" >/dev/null

step "3/7 — waiting for the function update to finish"
aws lambda wait function-updated --region "$AWS_REGION" --function-name "$LAMBDA_FUNCTION"

step "4/7 — resolving the public backend URL"
# Preferred: Lambda Function URL. Fallback: API Gateway HTTP API in front of
# the function (Function URLs return 403 in this AWS account as of 2026-09-27;
# see SETUP.md step 4). The API id is discovered by the "budget-api" name tag.
FUNC_URL="$(aws lambda get-function-url-config --region "$AWS_REGION" \
  --function-name "$LAMBDA_FUNCTION" --query FunctionUrl --output text 2>/dev/null)" || true
if [ -z "$FUNC_URL" ] || [ "$FUNC_URL" = "None" ]; then
  API_ID="$(aws apigatewayv2 get-apis --region "$AWS_REGION" \
    --query "Items[?Name=='budget-api'].ApiId" --output text 2>/dev/null)"
  [ -n "$API_ID" ] && [ "$API_ID" != "None" ] \
    || fail "No Function URL and no 'budget-api' API Gateway found. Do SETUP.md step 4 first."
  FUNC_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com"
fi
echo "Backend URL: $FUNC_URL"

step "5/7 — building the web frontend"
[ -d "$WEB_DIR/node_modules" ] || fail "$WEB_DIR/node_modules is missing — run 'npm install' inside web/ once first."
(
  cd "$WEB_DIR"
  # Vite bakes these in at build time — they cannot be changed without rebuilding.
  VITE_BACKEND_URL="$FUNC_URL" \
  VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
  VITE_SUPABASE_PUBLISHABLE_KEY="$VITE_SUPABASE_PUBLISHABLE_KEY" \
  npm run build
)

step "6/7 — syncing web/dist to s3://$S3_BUCKET"
aws s3 sync "$WEB_DIR/dist/" "s3://$S3_BUCKET" --delete --region "$AWS_REGION"

step "7/7 — invalidating the CloudFront cache"
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DIST_ID" --paths "/*" >/dev/null

echo
echo "Deployed."
echo "  API:      $FUNC_URL"
echo "  Web:      https://duj1bo2j1usp2.cloudfront.net  (CloudFront distribution E1C1I0FMZGWO4D)"
echo "  Image:    $ECR_URI:$SHA"
