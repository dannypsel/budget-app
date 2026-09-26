"""AWS Lambda entry point.

The deploy pipeline builds a Lambda container image (ECR) that expects module
`lambda_handler` with object `handler` — this exact contract. Mangum adapts
the FastAPI ASGI app to Lambda events, including the Lambda Function URL
payload format (v2.0) this service is invoked through.

Local dev does NOT use this file: run `uvicorn api:app` instead (see
scripts/local-dev.sh).
"""
from mangum import Mangum

from api import app

handler = Mangum(app)
