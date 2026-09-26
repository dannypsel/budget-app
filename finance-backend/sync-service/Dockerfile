# PocketLens sync service — FastAPI API on AWS Lambda (container image).
# Build context: finance-backend/sync-service/
#
# Deploy: the deploy worker builds this image and pushes it to ECR, and Lambda
# invokes it through a Lambda Function URL:
#   docker build --platform linux/arm64 -t pocketlens-api finance-backend/sync-service
#
# Architecture note: the base image below is multi-arch; this Dockerfile
# targets ARM64 (Graviton2 — cheaper and faster per ms on Lambda). Rebuild
# with --platform linux/amd64 if the deployment targets x86_64 instead.
#
# Lambda contract: CMD is the lambda_handler.handler Mangum adapter object;
# lambda_handler.py documents the exact (module, object) contract the deploy
# worker expects. Local dev never uses this Dockerfile — run uvicorn directly
# (see scripts/local-dev.sh), which is why uvicorn stays in requirements.txt.
FROM public.ecr.aws/lambda/python:3.12

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . ${LAMBDA_TASK_ROOT}

CMD ["lambda_handler.handler"]
