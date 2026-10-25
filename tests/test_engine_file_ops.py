"""aihub-code's own file tools: byte-preserving edits (CRLF, latin-1), no
newline translation on write. The runner must use these, never AIhub 1.5.0's
edit_file / write_file, so the diff the user approves equals what is written
(ruling R13)."""
import os

import pytest

from aihub.tools import workdir as wd
from aihub_code import tools as ht
from aihub_code.diffs import preview
from aihub_code.engine import tools as engine_tools
from aihub_code.engine.file_ops import apply_edit, decode_text, edit_file, write_file
from aihub_code.todo import TodoList


class _NoCheckpoints:
    def record_before(self, path):
        pass

    def note_shell(self, cmd):
        pass


@pytest.fixture
def runner(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    events = []
    r = ht.CodeToolRunner(todo=TodoList(), checkpoints=_NoCheckpoints(),
                          emit=lambda k, d: events.append((k, d)),
                          cancel_check=lambda: False, budget=8000)
    return tmp_path, r, events


def test_apply_edit_unique_match_only():
    assert apply_edit("a\nb\n", "b", "c") == ("a\nc\n", None)
    new, err = apply_edit("x x", "x", "y")
    assert new is None and "appears 2 times" in err
    new, err = apply_edit("abc", "zzz", "y")
    assert new is None and "not found" in err


def test_apply_edit_lf_old_matches_crlf_file_and_converts_new():
    assert apply_edit("a\r\nb\r\nc\r\n", "b\nc", "B\nC")[0] == "a\r\nB\r\nC\r\n"


def test_decode_text_utf8_then_latin1():
    assert decode_text("café".encode("utf-8")) == ("café", "utf-8")
    assert decode_text(b"caf\xe9") == ("caf\xe9", "latin-1")


def test_edit_file_keeps_crlf_and_latin1(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    p = tmp_path / "c.txt"
    p.write_bytes("caf\xe9\r\nold\r\nna\xefve\r\n".encode("latin-1"))
    assert "[Edit OK]" in edit_file("c.txt", "old", "n\xfcw")
    assert p.read_bytes() == "caf\xe9\r\nn\xfcw\r\nna\xefve\r\n".encode("latin-1")


def test_edit_file_refuses_text_a_latin1_file_cannot_hold(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    p = tmp_path / "l.txt"
    p.write_bytes(b"caf\xe9\nold\n")
    assert "cannot hold" in edit_file("l.txt", "old", "中")
    assert p.read_bytes() == b"caf\xe9\nold\n"


def test_write_file_does_not_translate_newlines(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    assert "[File OK]" in write_file("w.txt", "a\r\nb\nc")
    assert (tmp_path / "w.txt").read_bytes() == b"a\r\nb\nc"


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")
def test_file_tools_refuse_special_files(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    os.mkfifo(tmp_path / "pipe")
    assert "Not a regular file" in write_file("pipe", "x")
    assert "Not a regular file" in edit_file("pipe", "a", "b")


def test_runner_edit_crlf_file_matches_preview_and_keeps_bytes(runner):
    tmp, r, events = runner
    p = tmp / "c.txt"
    p.write_bytes(b"a\r\nb\r\nc\r\nd\r\n")
    args = {"path": "c.txt", "old": "b\nc", "new": "B\nC\nX"}
    d = preview("edit_file", args)
    out = r("edit_file", args)
    assert "[Edit OK]" in out
    assert p.read_bytes() == b"a\r\nB\r\nC\r\nX\r\nd\r\n"
    [(kind, shown)] = [e for e in events if e[0] == "code_diff"]
    assert shown["added"] == d.added == 3 and shown["removed"] == d.removed == 2


def test_runner_edit_latin1_file_keeps_bytes(runner):
    tmp, r, _ = runner
    p = tmp / "l.txt"
    p.write_bytes("caf\xe9\nold\nna\xefve\n".encode("latin-1"))
    assert "[Edit OK]" in r("edit_file", {"path": "l.txt", "old": "old", "new": "n\xfcw"})
    assert p.read_bytes() == "caf\xe9\nn\xfcw\nna\xefve\n".encode("latin-1")


def test_runner_write_file_keeps_crlf_as_given(runner):
    tmp, r, _ = runner
    assert "[File OK]" in r("write_file", {"path": "w.txt", "content": "a\r\nb\n"})
    assert (tmp / "w.txt").read_bytes() == b"a\r\nb\n"


def test_runner_never_calls_aihubs_own_edit_and_write(runner, monkeypatch):
    # AIhub 1.5.0's versions re-encode the file: they must not be reachable.
    import aihub.tools as aihub_tools
    tmp, r, _ = runner

    def boom(*a, **k):
        raise AssertionError("aihub's own file tool was called")

    monkeypatch.setitem(aihub_tools.TOOLS_REGISTRY, "edit_file", boom)
    monkeypatch.setitem(aihub_tools.TOOLS_REGISTRY, "write_file", boom)
    (tmp / "f.txt").write_bytes(b"x\r\ny\r\n")
    assert "[Edit OK]" in r("edit_file", {"path": "f.txt", "old": "x", "new": "z"})
    assert "[File OK]" in r("write_file", {"path": "g.txt", "content": "q"})


def test_aihub_1_5_0_edit_would_have_lost_the_crlf(tmp_path, monkeypatch):
    # The reason aihub-code has its own copy: this is what 1.5.0 does.
    from aihub.tools.file_ops import edit_file as aihub_edit
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    p = tmp_path / "c.txt"
    p.write_bytes(b"a\r\nb\r\n")
    aihub_edit("c.txt", "b", "c")
    assert p.read_bytes() != b"a\r\nc\r\n"


def test_run_tool_fits_sloppy_arguments_like_aihub(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))
    (tmp_path / "f.txt").write_text("a")
    # unknown parameter dropped, as aihub.tools.run_tool does
    assert "[Edit OK]" in engine_tools.run_tool("edit_file", path="f.txt", old="a", new="b", extra=1)
    assert "[Tool Error] Bad arguments" in engine_tools.run_tool("edit_file", path="f.txt")


def test_run_tool_passes_other_tools_to_aihub(monkeypatch):
    seen = []
    monkeypatch.setattr("aihub.tools.run_tool", lambda name, **kw: seen.append((name, kw)) or "ok")
    assert engine_tools.run_tool("list_files", path=".") == "ok"
    assert seen == [("list_files", {"path": "."})]
