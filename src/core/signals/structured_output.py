from __future__ import annotations

import json


ALLOWED_ACTIONS = {
    "buy",
    "add",
    "reduce",
    "sell",
    "hold",
    "watch",
    "alert",
    "avoid",
}

ACTION_ALIASES = {
    "build": "add",
}


TAG_START = "<!--PANWATCH_JSON-->"
TAG_END = "<!--/PANWATCH_JSON-->"
LEGACY_TAG_START = "<STRUCTURED_OUTPUT>"
LEGACY_TAG_END = "</STRUCTURED_OUTPUT>"


def _find_last_tagged_block(
    text: str,
    tag_pairs: list[tuple[str, str]],
) -> tuple[int, int, str, str] | None:
    """Find the last valid tagged block among multiple tag pairs."""
    raw = text or ""
    candidates: list[tuple[int, int, str, str]] = []
    for start, end in tag_pairs:
        i = raw.rfind(start)
        if i < 0:
            continue
        j = raw.rfind(end)
        if j < 0 or j <= i:
            continue
        candidates.append((i, j, start, end))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])


def try_parse_action_json(text: str) -> dict | None:
    """Parse JSON-only output. Returns dict on success."""
    raw = (text or "").strip()
    if not raw:
        return None

    # Allow fenced code blocks (```json ... ```)
    if raw.startswith("```"):
        lines = raw.splitlines()
        if len(lines) >= 3 and lines[0].lstrip().startswith("```"):
            if lines[-1].strip().startswith("```"):
                raw = "\n".join(lines[1:-1]).strip()
        else:
            raw = raw.strip("`").strip()
    # Allow "json" prefix line without code fences.
    # Example:
    # json
    # {"action":"buy", ...}
    lines = raw.splitlines()
    if lines and lines[0].strip().lower() == "json":
        raw = "\n".join(lines[1:]).strip()
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    action = (obj.get("action") or "").strip().lower()
    if action in ACTION_ALIASES:
        obj["action"] = ACTION_ALIASES[action]
        action = obj["action"]
    if action and action not in ALLOWED_ACTIONS:
        return None
    return obj


def try_extract_tagged_json(
    text: str, *, start: str = TAG_START, end: str = TAG_END
) -> dict | None:
    """Extract a tagged JSON object from a larger text.

    Expected format at the end of the response:
    <!--PANWATCH_JSON-->
    { ... }
    <!--/PANWATCH_JSON-->
    """

    raw = text or ""
    tag_pairs = [(start, end)]
    if start == TAG_START and end == TAG_END:
        tag_pairs.append((LEGACY_TAG_START, LEGACY_TAG_END))
    block = _find_last_tagged_block(raw, tag_pairs)
    if block is None:
        return None
    i, j, block_start, _ = block
    payload = raw[i + len(block_start) : j].strip()
    if not payload:
        return None
    try:
        obj = json.loads(payload)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def strip_tagged_json(text: str, *, start: str = TAG_START, end: str = TAG_END) -> str:
    """Remove tagged JSON block from text (if present)."""
    raw = text or ""
    tag_pairs = [(start, end)]
    if start == TAG_START and end == TAG_END:
        tag_pairs.append((LEGACY_TAG_START, LEGACY_TAG_END))
    block = _find_last_tagged_block(raw, tag_pairs)
    if block is None:
        return raw
    i, j, _, block_end = block
    return (raw[:i] + raw[j + len(block_end) :]).strip()
