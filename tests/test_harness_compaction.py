import pytest

from aihub_code.compaction import (
    SUMMARY_HEADINGS, SUMMARY_PREFIX, Compactor, estimate_tokens,
    fallback_summary, make_completer, prune_tool_results, split_point)
from tests.conftest import FakeBackend, text

GOOD = "\n".join(f"## {h}\nx" for h in SUMMARY_HEADINGS)


def call(name, **args):
    return {"role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": name, "arguments": args}}]}


def history(big=3000):
    return [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "first request " + "a" * 200},
        call("read_file", path="a.py"),
        {"role": "tool", "content": "R" * big},
        call("edit_file", path="src/app.py", old="x", new="y"),
        {"role": "tool", "content": "ok"},
        {"role": "assistant", "content": "done one"},
        {"role": "user", "content": "second request"},
        {"role": "assistant", "content": "done two"},
        {"role": "user", "content": "third request"},
        {"role": "assistant", "content": "done three"},
    ]


def never(_):
    raise AssertionError("complete must not be called")


def test_no_op_when_small():
    m = history(10)
    assert Compactor(never).maybe_compact(m, 100000) is None


def test_prune_first():
    m = history()
    ctx = int(estimate_tokens(m) / 0.8)
    r = Compactor(never).maybe_compact(m, ctx)
    assert r.method == "prune" and r.after < r.before
    assert "[pruned]" in m[3]["content"]


def test_summary_replaces_old_part():
    m = history()
    sys_msg = m[0]
    r = Compactor(lambda _: GOOD, 0.1).maybe_compact(m, 2000)
    assert r.method == "summary" and r.kept_turns == 2
    assert m[0] is sys_msg
    assert m[1]["role"] == "user" and m[1]["content"].startswith(SUMMARY_PREFIX)
    assert [x["content"] for x in m[2:] if x["role"] == "user"] == ["second request", "third request"]
    assert m[2]["content"] == "second request"


def test_bad_summary_falls_back():
    m = history()
    r = Compactor(lambda _: "ok", 0.1).maybe_compact(m, 2000)
    assert r.method == "fallback"
    assert m[1]["content"].startswith(SUMMARY_PREFIX)
    assert "src/app.py" in m[1]["content"]
    assert "read_file: 1" in m[1]["content"]


def test_complete_raising_or_non_str_falls_back():
    def boom(_):
        raise RuntimeError("down")
    for comp in (boom, lambda _: None, lambda _: 5):
        m = history()
        assert Compactor(comp, 0.1).maybe_compact(m, 2000).method == "fallback"


def test_never_splits_tool_pair():
    m = [
        {"role": "system", "content": "S"},
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a1"},
        call("read_file", path="x"),
        {"role": "user", "content": "queued"},
        {"role": "tool", "content": "res"},
        {"role": "assistant", "content": "a2"},
    ]
    # the naive cut is the queued user message, between the call and its result
    cut = split_point(m, 10000, keep_turns=1)
    assert cut == 3 and m[cut]["tool_calls"]


def test_split_point_never_zero_or_tool():
    m = history()
    for k in (1, 2, 5):
        c = split_point(m, 10000, k)
        assert c >= 1 and m[c]["role"] != "tool"
    assert split_point([{"role": "system", "content": "s"}], 1000) == 1


def test_system_message_kept_verbatim():
    m = history()
    Compactor(lambda _: GOOD, 0.1).maybe_compact(m, 2000)
    assert m[0] == {"role": "system", "content": "SYS"}


def test_force_compacts_even_when_small():
    m = history(10)
    assert Compactor(lambda _: GOOD).maybe_compact(m, 100000, force=True) is not None


def test_recompaction_has_single_summary():
    m = history()
    c = Compactor(lambda _: GOOD, 0.1)
    c.maybe_compact(m, 2000)
    m += [{"role": "user", "content": "fourth"}, {"role": "assistant", "content": "d" * 500},
          {"role": "user", "content": "fifth"}, {"role": "assistant", "content": "e"}]
    seen = []
    c2 = Compactor(lambda msgs: seen.append(msgs[1]["content"]) or GOOD, 0.1)
    r = c2.maybe_compact(m, 2000, force=True)
    assert r is not None
    assert sum(x["content"].startswith(SUMMARY_PREFIX) for x in m) == 1
    assert m[1]["content"].startswith(SUMMARY_PREFIX)
    assert "Previous summary" in seen[0]
    assert SUMMARY_PREFIX not in m[1]["content"][len(SUMMARY_PREFIX):]


def test_prune_tool_results_counts():
    m = history()
    assert prune_tool_results(m, 4) == 1
    assert prune_tool_results(m, 4) == 0
    assert len(m[3]["content"]) == 510


def test_fallback_lists_files():
    s = fallback_summary(history())
    assert s.startswith(SUMMARY_PREFIX) and "src/app.py" in s


def test_make_completer_joins_chunks():
    fb = FakeBackend([[text("he"), {"message": {}}, {"done": True}, {"message": {"content": "llo", "thinking": "t"}}]])
    out = make_completer(fb, "m", 4096)([{"role": "user", "content": "x"}])
    assert out == "hello" and fb.closed == 1 and fb.tools_seen == [None]


def long_turn(rounds=30, size=3000):
    m = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "do the big thing"}]
    for i in range(rounds):
        m.append(call("read_file", path=f"f{i}.py"))
        m.append({"role": "tool", "content": f"{i}:" + "z" * size})
    m.append({"role": "assistant", "content": "working"})
    return m


def test_single_turn_long_tool_loop_compacts():
    m = long_turn()
    before = estimate_tokens(m)
    r = Compactor(lambda _: GOOD).maybe_compact(m, 4000)
    assert r is not None and r.kept_turns == 1 and r.after < before
    assert m[0]["content"] == "SYS"
    assert m[1]["content"].startswith(SUMMARY_PREFIX)
    assert m[2] == {"role": "user", "content": "do the big thing"}
    assert m[3]["role"] == "assistant"
    for i, x in enumerate(m):
        if x["role"] == "tool":
            assert m[i - 1].get("tool_calls") or m[i - 1]["role"] == "tool"


def test_single_turn_prune_only():
    m = long_turn(rounds=4, size=3000)
    ctx = int(estimate_tokens(m) / 0.8)
    r = Compactor(never).maybe_compact(m, ctx)
    assert r is not None and r.method == "prune"
    assert any("[pruned]" in x["content"] for x in m)


def test_later_chunk_failure_keeps_earlier_summary():
    calls = []

    def comp(_):
        calls.append(1)
        return GOOD if len(calls) == 1 else "bad"
    m = long_turn()
    r = Compactor(comp).maybe_compact(m, 4000)
    assert r.method == "fallback" and len(calls) >= 2
    assert "## Goal" in m[1]["content"] and "Tools used:" in m[1]["content"]
    assert m[1]["content"].count(SUMMARY_PREFIX) == 1


def test_chunk_prompt_stays_within_ctx():
    sizes = []

    def comp(msgs):
        sizes.append(len(msgs[1]["content"]))
        return GOOD
    Compactor(comp).maybe_compact(long_turn(), 4000)
    assert max(sizes) <= int(0.45 * 4000 * 3.2 / 1.1) + 300


def test_parallel_tool_calls_not_split():
    three = {"role": "assistant", "content": "", "tool_calls": [
        {"function": {"name": "read_file", "arguments": {"path": p}}} for p in "abc"]}
    m = [{"role": "system", "content": "S"}, {"role": "user", "content": "u1"}, three,
         {"role": "tool", "content": "ra"}, {"role": "user", "content": "queued"},
         {"role": "tool", "content": "rb"}, {"role": "tool", "content": "rc"},
         {"role": "assistant", "content": "end"}]
    assert split_point(m, 10000, keep_turns=1) == 2


def test_cancel_between_summary_chunks_falls_back_without_asking_again():
    calls = []
    cancelled = []

    def comp(_):
        calls.append(1)
        cancelled.append(True)          # the user cancels while chunk 1 is written
        return GOOD
    m = long_turn()
    r = Compactor(comp, cancel_check=lambda: bool(cancelled)).maybe_compact(m, 4000)
    assert len(calls) == 1 and r.method == "fallback"
    assert "## Goal" in m[1]["content"] and "Tools used:" in m[1]["content"]


def test_make_completer_stops_and_closes_on_cancel():
    from aihub_code.compaction import CompactionCancelled
    fb = FakeBackend([[text("a"), text("b"), text("c"), text("d")]])

    def check():
        return fb.pulled >= 2
    with pytest.raises(CompactionCancelled):
        make_completer(fb, "m", 4096, check)([{"role": "user", "content": "x"}])
    assert fb.pulled == 2 and fb.closed == 1
