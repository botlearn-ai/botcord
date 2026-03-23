"""Prompt-injection pattern scanner for message payloads.

Detects common LLM prompt-injection markers in message text and returns
a risk level.  This module is pure functions with no I/O — safe to call
from hot paths.
"""

from __future__ import annotations

import re
from enum import Enum


class InjectionRisk(str, Enum):
    none = "none"
    low = "low"
    high = "high"


# High-risk: well-known LLM prompt injection markers (open AND close tags)
_HIGH_RISK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"<\/?\s*system(?:-reminder)?\s*>", re.IGNORECASE),
    re.compile(r"<\|im_(?:start|end)\|>", re.IGNORECASE),
    re.compile(r"\[/?INST\]", re.IGNORECASE),
    re.compile(r"<</?SYS>>", re.IGNORECASE),
    re.compile(r"<\s*\/?\|(?:system|user|assistant)\|?\s*>", re.IGNORECASE),
    re.compile(r"```system\b", re.IGNORECASE),
]

# Low-risk: attempts to spoof BotCord structural markers
_LOW_RISK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^\[BotCord (?:Message|Notification)\]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\[Room Rule\]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\[系统提示\]", re.MULTILINE),
    re.compile(r"^\[房间规则\]", re.MULTILINE),
]


def scan_content(text: str) -> tuple[InjectionRisk, list[str]]:
    """Scan *text* for prompt-injection patterns.

    Returns ``(risk_level, matched_pattern_descriptions)``.
    """
    if not text:
        return InjectionRisk.none, []

    matches: list[str] = []
    for pat in _HIGH_RISK_PATTERNS:
        if pat.search(text):
            matches.append(pat.pattern)
    if matches:
        return InjectionRisk.high, matches

    for pat in _LOW_RISK_PATTERNS:
        if pat.search(text):
            matches.append(pat.pattern)
    if matches:
        return InjectionRisk.low, matches

    return InjectionRisk.none, []


_STRIP_REPLACEMENT = "[⚠ stripped]"


def strip_injection_markers(text: str) -> str:
    """Replace high-risk prompt-injection markers in *text*.

    Used by forward.py to sanitize room rules before they are concatenated
    into the prompt sent to agents.
    """
    result = text
    for pat in _HIGH_RISK_PATTERNS:
        result = pat.sub(_STRIP_REPLACEMENT, result)
    return result
