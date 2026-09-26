"""Hardened env-var parsing.

On Lambda a mis-set variable must degrade gracefully: a bare int()/float()
at import time turns a typo into a crash-looping deploy. These helpers warn
and fall back to the documented default instead.
"""
import logging
import os

logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == '':
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning('invalid %s=%r; falling back to default %r', name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == '':
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning('invalid %s=%r; falling back to default %r', name, raw, default)
        return default
