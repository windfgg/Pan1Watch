from src.core.signals.structured_output import (
    strip_tagged_json,
    try_extract_tagged_json,
    try_parse_action_json,
)


def test_try_parse_action_json_plain_json_prefix() -> None:
    text = '\njson\n{"action":"add","action_label":"建仓","reason":"突破"}\n'
    obj = try_parse_action_json(text)
    assert obj is not None
    assert obj.get("action") == "add"
    assert obj.get("action_label") == "建仓"


def test_try_parse_action_json_fenced_json() -> None:
    text = '```json\n{"action":"reduce","action_label":"减仓"}\n```'
    obj = try_parse_action_json(text)
    assert obj is not None
    assert obj.get("action") == "reduce"


def test_try_parse_action_json_action_alias_build_to_add() -> None:
    text = '\njson\n{"action":"build","action_label":"建仓","reason":"突破"}\n'
    obj = try_parse_action_json(text)
    assert obj is not None
    assert obj.get("action") == "add"


def test_try_extract_tagged_json_legacy_structured_output() -> None:
    text = """分析正文\n<STRUCTURED_OUTPUT>\n{"summary":"ok","funds":{"159217":{"action":"dca"}}}\n</STRUCTURED_OUTPUT>"""
    obj = try_extract_tagged_json(text)
    assert obj is not None
    assert obj.get("summary") == "ok"


def test_strip_tagged_json_legacy_structured_output() -> None:
    text = """分析正文\n<STRUCTURED_OUTPUT>\n{"summary":"ok"}\n</STRUCTURED_OUTPUT>"""
    cleaned = strip_tagged_json(text)
    assert cleaned == "分析正文"
