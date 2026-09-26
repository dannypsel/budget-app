"""The Lambda entry point: module `lambda_handler`, object `handler`.

This is a contract with the deploy worker (it builds the ECR image expecting
exactly this). The test builds a minimal Lambda Function URL payload (v2.0)
for GET /health and asserts a 200 — with zero env/AWS setup: importing
lambda_handler (and therefore api.py) must never require env vars.
"""
import json

import lambda_handler


def _function_url_event(method: str, path: str) -> dict:
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"host": "abc123.lambda-url.us-east-1.on.aws"},
        "requestContext": {
            "http": {
                "method": method,
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "test",
            },
        },
        "isBase64Encoded": False,
    }


def test_lambda_handler_contract():
    """lambda_handler.handler exists and is callable (the deploy contract)."""
    assert callable(lambda_handler.handler)


def test_health_via_function_url_event():
    resp = lambda_handler.handler(_function_url_event("GET", "/health"), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"status": "ok"}


def test_unknown_path_is_404_not_crash():
    resp = lambda_handler.handler(_function_url_event("GET", "/nope"), None)
    assert resp["statusCode"] == 404
