"""Brave Search merchant enrichment.

When Jev's confidence is below the user's threshold, we look the merchant up
(Brave Search API, free tier 2k queries/month) and re-classify once with the
enriched state. Only ever called on the low-confidence path, so API volume
stays tiny.

Endpoint: GET https://api.search.brave.com/res/v1/web/search
Auth:     X-Subscription-Token: <BRAVE_API_KEY>
"""

import logging
import os

import requests

from envutil import _env_float

logger = logging.getLogger(__name__)

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_TIMEOUT_S = _env_float("BRAVE_TIMEOUT_S", 15.0)


def brave_api_key() -> str | None:
    return os.environ.get("BRAVE_API_KEY")


def lookup_merchant(merchant: str, api_key: str | None = None, max_results: int = 3) -> str | None:
    """Return a short evidence blurb about the merchant, or None.

    Never raises — a failed lookup just means "no enrichment", and the
    transaction falls through to needs-review like any other low-confidence
    case."""
    api_key = api_key or brave_api_key()
    merchant = (merchant or "").strip()
    if not api_key or not merchant:
        return None
    try:
        resp = requests.get(
            BRAVE_URL,
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
            params={
                "q": f'what kind of business is "{merchant}" merchant',
                "count": max_results,
                "text_decorations": "0",
            },
            timeout=BRAVE_TIMEOUT_S,
        )
        resp.raise_for_status()
        results = (resp.json().get("web") or {}).get("results") or []
        bits = []
        for r in results[:max_results]:
            title = (r.get("title") or "").strip()
            desc = (r.get("description") or "").strip()
            if title or desc:
                bits.append(f"{title}: {desc}".strip(": "))
        return " | ".join(bits) or None
    except Exception:
        logger.exception("brave merchant lookup failed", extra={"merchant": merchant})
        return None
