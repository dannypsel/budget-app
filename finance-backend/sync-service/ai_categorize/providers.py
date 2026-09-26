"""Classifier providers for AI transaction categorization.

Jev (TypeSafe AI, "System One" decision model — NOT a chatbot):
  POST https://api.typesafe.ai/v1/systemone
  Authorization: Bearer <TYPESAFE_API_KEY>   (we read JEV_API_KEY, falling
  back to TYPESAFE_API_KEY for SDK-compat)
  Body: {
      "model": "jev-latest",                       # or "jev-1.13.0"
      "state": <text | object | array>,            # the evidence
      "questions": {
          "<qid>": {
              "type": "choice",
              "instructions": "Which category best fits transaction TXN-1?",
              "criteria": { "<category_id>": "<name> — <hint>", ... }
          }, ...
      }
  }
  Response answers.<qid> = {
      "type": "choice", "choice": "<category_id>",
      "probabilities": { "<category_id>": 0.94, ... },
      "confidence": 0.91            # calibrated: act on it, don't chat about it
  }

Verified against TypeSafe/OpenRouter docs, Sept 2026. Multiple questions are
evaluated in parallel against one shared state, so one HTTP call classifies a
whole batch (one question per transaction). Choice cardinality cap: 255
options per question — enforced here.

Swapping providers is a one-line config change: set AI_CLASSIFIER_PROVIDER to
'jev' | 'gemini' | 'off' (see get_provider). Gemini is a clean stub — the
swap point is real, the implementation is intentionally unwritten.
"""

import logging
import os
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import requests

from envutil import _env_float

logger = logging.getLogger(__name__)

# One HTTP call classifies this many transactions (one Choice question each).
# Independent benchmarks ran up to 25 decisions/call; 10 keeps payloads small.
JEV_BATCH_SIZE = 10
# Jev caps Choice questions at 255 options.
JEV_MAX_CHOICES = 255

JEV_API_URL = os.environ.get("JEV_API_URL", "https://api.typesafe.ai/v1/systemone")
JEV_MODEL = os.environ.get("JEV_MODEL", "jev-latest")
JEV_TIMEOUT_S = _env_float("JEV_TIMEOUT_S", 30.0)


def jev_api_key() -> str | None:
    """JEV_API_KEY primary; TYPESAFE_API_KEY fallback (official SDK env name)."""
    return os.environ.get("JEV_API_KEY") or os.environ.get("TYPESAFE_API_KEY")


@dataclass
class Classification:
    """One verdict: winning category id + calibrated confidence in [0,1]."""

    category_id: str | None
    confidence: float
    probabilities: dict = field(default_factory=dict)


class ClassifierProvider(ABC):
    """Swap point for the decision model. classify_batch takes
    [(txn_id, state_text, categories)] and returns one Classification per
    input, in order. categories = [(category_id, label)]."""

    name: str = "base"

    @abstractmethod
    def classify_batch(
        self,
        items: list[tuple[str, str, list[tuple[str, str]]]],
    ) -> list[Classification]: ...


class JevProvider(ClassifierProvider):
    """TypeSafe Jev via the direct System One API (plain HTTP, no SDK needed)."""

    name = "jev"

    def __init__(
        self, api_key: str | None = None, model: str | None = None, batch_size: int = JEV_BATCH_SIZE
    ):
        self.api_key = api_key or jev_api_key()
        if not self.api_key:
            raise RuntimeError("Jev provider needs JEV_API_KEY (or TYPESAFE_API_KEY) in env")
        self.model = model or JEV_MODEL
        self.batch_size = batch_size

    def classify_batch(self, items):
        out: list[Classification] = []
        for i in range(0, len(items), self.batch_size):
            out.extend(self._classify_call(items[i : i + self.batch_size]))
        return out

    def _classify_call(self, batch) -> list[Classification]:
        # criteria keys ARE the category ids — the winner comes back verbatim.
        criteria: dict[str, str] = {}
        for _tid, _state, cats in batch:
            for cid, label in cats:
                criteria[cid] = label
        if len(criteria) > JEV_MAX_CHOICES:
            raise ValueError(f"{len(criteria)} categories exceeds Jev 255-choice cap")

        questions = {}
        for txn_id, _state, _cats in batch:
            questions[f"txn_{txn_id}"] = {
                "type": "choice",
                "instructions": (
                    f"Which spending category best fits the transaction "
                    f"identified as {txn_id} in the state below? "
                    f"Judge only by what the transaction most plausibly is; "
                    f"if genuinely ambiguous, pick the closest fit."
                ),
                "criteria": criteria,
            }
        state = {"transactions": [{"id": txn_id, "detail": s} for txn_id, s, _ in batch]}

        resp = requests.post(
            JEV_API_URL,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={"model": self.model, "state": state, "questions": questions},
            timeout=JEV_TIMEOUT_S,
        )
        if resp.status_code == 401:
            raise RuntimeError("Jev API rejected the key (401) — check JEV_API_KEY")
        if resp.status_code == 422:
            raise RuntimeError(f"Jev rejected the question shape (422): {resp.text[:200]}")
        resp.raise_for_status()
        answers = resp.json().get("answers") or {}

        out = []
        for txn_id, _state, cats in batch:
            valid = {cid for cid, _ in cats}
            ans = answers.get(f"txn_{txn_id}") or {}
            choice = ans.get("choice")
            conf = ans.get("confidence", 0.0)
            try:
                conf = float(conf)
            except (TypeError, ValueError):
                conf = 0.0
            # Belt-and-braces: the model must not invent a category id.
            if choice not in valid:
                choice, conf = None, 0.0
            out.append(
                Classification(
                    category_id=choice,
                    confidence=max(0.0, min(1.0, conf)),
                    probabilities=ans.get("probabilities") or {},
                )
            )
        return out


class GeminiProvider(ClassifierProvider):
    """STUB — swap point for Google Gemini Flash.

    To implement: pip install google-generativeai, read GEMINI_API_KEY from
    env, send each transaction state with the category list as a constrained
    choice (response_mime_type='application/json' + response schema), parse
    {category_id, confidence}. The pipeline treats any ClassifierProvider
    identically, so no other code changes when this gets written.
    """

    name = "gemini"

    def __init__(self, *a, **k):
        raise NotImplementedError(_GEMINI_MSG)

    def classify_batch(self, items):
        raise NotImplementedError(_GEMINI_MSG)


_GEMINI_MSG = (
    "GeminiProvider is a stub — set AI_CLASSIFIER_PROVIDER=jev, or "
    "implement ai_categorize/providers.py::GeminiProvider (see docstring)"
)


def get_provider(name: str | None = None) -> ClassifierProvider | None:
    """One-line swap: AI_CLASSIFIER_PROVIDER=jev|gemini|off (default jev).

    Returns None for 'off'/empty (AI disabled). Raises on unknown names and
    on missing keys so misconfiguration fails loudly at startup, not silently
    mid-sync."""
    name = os.environ.get("AI_CLASSIFIER_PROVIDER", "jev") if name is None else name
    name = name.strip().lower()
    if name in ("", "off", "none", "disabled"):
        return None
    if name == "jev":
        return JevProvider()
    if name == "gemini":
        return GeminiProvider()
    raise ValueError(f"unknown AI_CLASSIFIER_PROVIDER={name!r} (want jev|gemini|off)")


def classify_concurrent(
    provider: ClassifierProvider,
    items: list[tuple[str, str, list[tuple[str, str]]]],
    workers: int = 4,
) -> list[Classification]:
    """Run provider batches across a small thread pool; order preserved.

    Jev answers in 70–500ms, so a handful of concurrent calls keeps a
    few-hundred-transaction backlog to seconds. Failures in one batch don't
    poison the others — they come back as zero-confidence (needs review)."""
    if not items:
        return []
    # classify_batch already chunks internally; these chunks are just for
    # parallelism across the thread pool.
    chunks = [items[i : i + JEV_BATCH_SIZE] for i in range(0, len(items), JEV_BATCH_SIZE)]
    results: dict[int, list[Classification]] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futs = {pool.submit(provider.classify_batch, c): n for n, c in enumerate(chunks)}
        for fut in as_completed(futs):
            n = futs[fut]
            try:
                results[n] = fut.result()
            except Exception:
                logger.exception("classifier batch failed")
                results[n] = [Classification(None, 0.0) for _ in chunks[n]]
    return [c for n in sorted(results) for c in results[n]]
