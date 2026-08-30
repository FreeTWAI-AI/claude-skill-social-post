#!/usr/bin/env python3
"""Domain validation for hash-bound, post-level content analysis."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from datetime import datetime
from typing import Any


CONFIDENCE_VALUES = {"low", "medium", "high"}
ANALYSIS_STATUS_VALUES = {"pending", "complete", "excluded_placeholder"}
WEEKDAYS_ZH_TW = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
VIDEO_TYPE_TOKENS = ("reel", "video", "short", "drama")


def _exact_non_negative_int(value: Any, path: str, errors: list[str]) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        errors.append(f"{path} must be a non-negative integer")


def caption_counts(caption: str) -> dict[str, int]:
    """Return deterministic caption metrics used by every analyzed post."""
    paragraphs = len(re.split(r"(?:\r?\n){2,}", caption)) if caption else 0
    return {
        "characters_including_spaces": len(caption),
        "characters_excluding_whitespace": len(re.sub(r"\s", "", caption)),
        "content_characters_excluding_whitespace_and_punctuation": sum(
            character.isalnum() for character in caption
        ),
        "spaces": caption.count(" "),
        "paragraph_count": paragraphs,
        "explicit_line_breaks": caption.count("\n"),
        "separator_blocks": caption.count("──"),
        "full_width_commas": caption.count("，"),
        "enumeration_commas": caption.count("、"),
        "full_width_periods": caption.count("。"),
        "full_width_question_marks": caption.count("？"),
        "full_width_exclamation_marks": caption.count("！"),
        "corner_quote_marks": caption.count("「") + caption.count("」"),
        "book_title_marks": caption.count("《") + caption.count("》"),
        "links": len(re.findall(r"https?://", caption)),
        "hashtags": len(re.findall(r"(?<!\S)#[^\s#]+", caption)),
    }


def punctuation_profile(caption: str) -> dict[str, Any]:
    """Return a complete Unicode punctuation inventory plus repeated-mark runs.

    The legacy fixed counters remain stable for existing ledger rows.  This profile is
    computed at comparison time so ASCII punctuation, colons, ellipses, brackets and
    future punctuation marks are not silently omitted from analysis.
    """
    punctuation = [
        character for character in caption
        if unicodedata.category(character).startswith("P")
    ]
    histogram = dict(sorted(Counter(punctuation).items(), key=lambda item: item[0]))
    repeated_runs: list[dict[str, Any]] = []
    start = 0
    while start < len(caption):
        mark = caption[start]
        if not unicodedata.category(mark).startswith("P"):
            start += 1
            continue
        end = start + 1
        while end < len(caption) and caption[end] == mark:
            end += 1
        if end - start >= 2:
            repeated_runs.append({"mark": mark, "length": end - start, "start": start})
        start = end
    return {
        "total": len(punctuation),
        "unique_marks": len(histogram),
        "histogram": histogram,
        "repeated_runs": repeated_runs,
    }


def _validate_format_features(post: dict[str, Any], label: str, errors: list[str]) -> None:
    formatting = post.get("format_features")
    caption = post.get("caption")
    if not isinstance(formatting, dict):
        errors.append(f"{label}.format_features must be an object")
        return
    if not isinstance(caption, str):
        return
    for key, expected in caption_counts(caption).items():
        observed = formatting.get(key)
        _exact_non_negative_int(observed, f"{label}.format_features.{key}", errors)
        if isinstance(observed, int) and not isinstance(observed, bool) and observed != expected:
            errors.append(f"{label}.format_features.{key}={observed} does not match caption value {expected}")
    for key in ("emoji", "explicit_cta"):
        _exact_non_negative_int(formatting.get(key), f"{label}.format_features.{key}", errors)
    for key in ("surface", "caption_layout"):
        if not isinstance(formatting.get(key), str) or not formatting[key].strip():
            errors.append(f"{label}.format_features.{key} must be a non-empty string")
    if post.get("content_type") == "background_text_post":
        _validate_background_card(formatting, label, errors)
    elif any(token in str(post.get("content_type", "")).casefold() for token in VIDEO_TYPE_TOKENS):
        if formatting.get("video_orientation") != "vertical_9_16":
            errors.append(f"{label}.format_features.video_orientation must be vertical_9_16")


def _validate_background_card(formatting: dict[str, Any], label: str, errors: list[str]) -> None:
    expected_card = {
        "facebook_background_style": True,
        "background_color": "black",
        "text_color": "white",
        "text_weight": "bold",
        "alignment": "center",
    }
    for key, expected in expected_card.items():
        if formatting.get(key) != expected:
            errors.append(f"{label}.format_features.{key} must be {expected!r}")
    rendered = formatting.get("rendered_line_count_observed")
    if not isinstance(rendered, int) or isinstance(rendered, bool) or rendered < 1:
        errors.append(f"{label}.format_features.rendered_line_count_observed must be positive")


def _validate_wording_features(post: dict[str, Any], label: str, status: str, errors: list[str]) -> None:
    wording = post.get("wording_features")
    if not isinstance(wording, dict):
        errors.append(f"{label}.wording_features must be an object")
        return
    required_strings = ("opening",) if status == "excluded_placeholder" else (
        "opening", "hook", "mechanism", "differentiator", "proof_style", "cta",
    )
    for key in required_strings:
        if not isinstance(wording.get(key), str) or not wording[key].strip():
            errors.append(f"{label}.wording_features.{key} must be a non-empty string")
    for key in ("keywords", "named_entities", "numbers_observed", "numeric_language"):
        if not isinstance(wording.get(key), list):
            errors.append(f"{label}.wording_features.{key} must be a list")
    if status != "complete":
        return
    for key in ("keywords", "voice", "punctuation_style"):
        values = wording.get(key)
        if not isinstance(values, list) or not values or any(
            not isinstance(item, str) or not item.strip() for item in values
        ):
            errors.append(f"{label}.wording_features.{key} must be a non-empty string list")


def _validate_publication_context(
    post: dict[str, Any], label: str, published: datetime | None, errors: list[str],
) -> None:
    context = post.get("publication_context")
    if not isinstance(context, dict):
        errors.append(f"{label}.publication_context must be an object")
        return
    if published is None:
        return
    expected = {
        "local_date": published.date().isoformat(),
        "weekday_zh_tw": WEEKDAYS_ZH_TW[published.weekday()],
        "local_time": published.strftime("%H:%M"),
    }
    for key, value in expected.items():
        if context.get(key) != value:
            errors.append(f"{label}.publication_context.{key} must be {value}")
    if not isinstance(context.get("daypart"), str) or not context["daypart"].strip():
        errors.append(f"{label}.publication_context.daypart must be a non-empty string")


def validate_post_analysis(
    post: dict[str, Any], label: str, published: datetime | None,
    errors: list[str], warnings: list[str],
) -> None:
    """Validate analysis identity, eligibility, deterministic features and context."""
    status = post.get("analysis_status")
    if status not in ANALYSIS_STATUS_VALUES:
        errors.append(f"{label}.analysis_status must be one of {sorted(ANALYSIS_STATUS_VALUES)}")
        return
    version = post.get("analysis_version")
    if not isinstance(version, str) or not version.strip():
        errors.append(f"{label}.analysis_version must be a non-empty string")
    eligible = post.get("analysis_eligible")
    if not isinstance(eligible, bool):
        errors.append(f"{label}.analysis_eligible must be boolean")
    caption = post.get("caption")
    digest = post.get("caption_sha256")
    if not isinstance(digest, str) or not HEX_256.fullmatch(digest):
        errors.append(f"{label}.caption_sha256 must be a lowercase SHA-256 digest")
    elif isinstance(caption, str) and hashlib.sha256(caption.encode("utf-8")).hexdigest() != digest:
        errors.append(f"{label}.caption_sha256 does not match caption")
    if status == "pending":
        if eligible is not False:
            errors.append(f"{label} pending analysis must set analysis_eligible=false")
        warnings.append(f"{label} semantic post analysis is pending and excluded from pattern learning")
        return
    if version == "pending":
        errors.append(f"{label}.analysis_version cannot be pending after analysis")
    evidence = post.get("analysis_evidence")
    if not isinstance(evidence, str) or not evidence.strip():
        errors.append(f"{label}.analysis_evidence is required for analyzed posts")
    for field in ("published_at_confidence", "caption_confidence"):
        if post.get(field) not in CONFIDENCE_VALUES:
            errors.append(f"{label}.{field} is required for analyzed posts")
    if status == "excluded_placeholder":
        if eligible is not False:
            errors.append(f"{label} placeholder analysis must set analysis_eligible=false")
        if not isinstance(post.get("analysis_exclusion_reason"), str) or not post["analysis_exclusion_reason"].strip():
            errors.append(f"{label}.analysis_exclusion_reason is required")
    elif eligible is not True:
        errors.append(f"{label} complete analysis must set analysis_eligible=true")
    _validate_format_features(post, label, errors)
    _validate_wording_features(post, label, status, errors)
    _validate_publication_context(post, label, published, errors)
