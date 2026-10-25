"""Tool calls a model wrote as plain text instead of native tool_calls."""
from aihub_code.engine.chat import _extract_fallback_tool_calls

NAMES = {"read_file", "edit_file", "run_terminal"}


def _names(calls):
    return [c["function"]["name"] for c in calls]


def test_single_bare_object():
    calls = _extract_fallback_tool_calls(
        '{"name": "read_file", "arguments": {"path": "calc.py"}}', NAMES)
    assert _names(calls) == ["read_file"]
    assert calls[0]["function"]["arguments"] == {"path": "calc.py"}


def test_several_objects_one_per_line():
    # qwen2.5-coder:7b on Ollama answers like this (seen live 2026-10-25).
    text = ('{"name": "read_file", "arguments": {"path": "calc.py"}}\n'
            '{"name": "edit_file", "arguments": {"path": "calc.py", '
            '"old": "a - b", "new": "a + b"}}')
    calls = _extract_fallback_tool_calls(text, NAMES)
    assert _names(calls) == ["read_file", "edit_file"]
    assert calls[1]["function"]["arguments"]["new"] == "a + b"


def test_objects_after_a_short_preamble():
    text = ('I will read the file first.\n'
            '{"name": "read_file", "arguments": {"path": "calc.py"}}')
    assert _names(_extract_fallback_tool_calls(text, NAMES)) == ["read_file"]


def test_unknown_names_and_plain_json_are_ignored():
    text = ('{"name": "rm_rf", "arguments": {}}\n'
            '{"answer": 42}\n'
            '{"name": "read_file", "arguments": {"path": "a"}}')
    assert _names(_extract_fallback_tool_calls(text, NAMES)) == ["read_file"]


def test_prose_with_braces_is_not_a_call():
    text = "Use a dict like {\"a\": 1} to configure it."
    assert _extract_fallback_tool_calls(text, NAMES) == []


def test_call_quoted_inside_a_long_answer_is_not_run():
    text = ("The fix is done. " * 20 + "\nIf you want to check it yourself, the tool "
            'call looks like {"name": "run_terminal", "arguments": {"command": "rm x"}} '
            "but you do not need it.")
    assert _extract_fallback_tool_calls(text, NAMES) == []


def test_tagged_and_fenced_still_work():
    tagged = '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>'
    fenced = '```json\n{"name": "run_terminal", "parameters": {"command": "ls"}}\n```'
    assert _names(_extract_fallback_tool_calls(tagged, NAMES)) == ["read_file"]
    assert _names(_extract_fallback_tool_calls(fenced, NAMES)) == ["run_terminal"]
