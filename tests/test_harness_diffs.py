import os

import pytest

from aihub_code.diffs import preview, unified_diff
from aihub.tools import workdir as wd


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(wd, "_session_dir", str(tmp_path))


def test_edit_preview_exact_text(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "a.txt").write_bytes(b"one\nold line\nthree\n")  # LF on every OS
    d = preview("edit_file", {"path": "a.txt", "old": "old line", "new": "new line"})
    assert d.added == d.removed == 1
    assert "--- a/a.txt" in d.text and "+++ b/a.txt" in d.text
    assert "-old line\n" in d.text and "+new line\n" in d.text
    assert not d.created and not d.error


def test_edit_preview_not_found_error(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "a.txt").write_text("x\n")
    assert "not found" in preview("edit_file", {"path": "a.txt", "old": "zz", "new": "y"}).error
    assert "File not found" in preview("edit_file", {"path": "nope", "old": "a", "new": "b"}).error


def test_edit_preview_not_unique_error(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "a.txt").write_text("x\nx\n")
    assert "appears 2 times" in preview("edit_file", {"path": "a.txt", "old": "x", "new": "y"}).error


def test_write_new_file_created(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    d = preview("write_file", {"path": "sub/new.txt", "content": "hi\nthere"})
    assert d.created and d.added == 2 and d.removed == 0
    assert "+there\n" in d.text
    assert not (tmp_path / "sub").exists()


def test_binary_summary(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "b.png").write_bytes(b"\x89PNG\0\0data")
    d = preview("write_file", {"path": "b.png", "content": "text"})
    assert d.text == "binary or large file (10 bytes)" and d.added == d.removed == 0


def test_large_diff_truncated(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "a.txt").write_text("".join(f"old {i}\n" for i in range(500)))
    d = preview("write_file", {"path": "a.txt", "content": "".join(f"new {i}\n" for i in range(500))})
    assert d.truncated and len(d.text.splitlines()) <= 201
    assert d.text.splitlines()[-1].startswith("... (")
    assert d.added == 500 and d.removed == 500


def test_crlf_file_preview_keeps_lines(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "c.txt").write_bytes(b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n")
    d = preview("edit_file", {"path": "c.txt", "old": "e", "new": "E"})
    assert d.added == d.removed == 1
    assert "-e\r\n" in d.text and "+E\r\n" in d.text


def test_preview_writes_nothing(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    p = tmp_path / "a.txt"
    p.write_bytes(b"keep\r\nme\n")
    preview("edit_file", {"path": "a.txt", "old": "keep", "new": "x"})
    preview("write_file", {"path": "a.txt", "content": "y"})
    preview("write_file", {"path": "z.txt", "content": "y"})
    assert p.read_bytes() == b"keep\r\nme\n" and not (tmp_path / "z.txt").exists()


def test_malformed_args_and_other_tools(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    assert preview("read_file", {"path": "a"}) is None
    d = preview("edit_file", {"path": 5, "old": None})
    assert d.error and d.path == "5"
    assert preview("write_file", {}).error
    assert preview("write_file", {"path": "a", "content": 3}).error


def test_no_trailing_newline_and_latin1(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    d = unified_diff("a\nb", "a\nc", str(tmp_path / "f"))
    assert "+c\n" in d.text and "-b\n" in d.text
    (tmp_path / "l.txt").write_bytes("caf\xe9\n".encode("latin-1"))
    assert preview("edit_file", {"path": "l.txt", "old": "caf", "new": "tea"}).added == 1
    assert preview("write_file", {"path": "a.txt", "content": "x"}).to_dict()["created"] is True


def test_crlf_edit_real_matches_preview(tmp_path, monkeypatch):
    from aihub_code.engine.file_ops import edit_file
    _setup(tmp_path, monkeypatch)
    p = tmp_path / "c.txt"
    p.write_bytes(b"a\r\nb\r\nc\r\nd\r\n")
    d = preview("edit_file", {"path": "c.txt", "old": "b\nc", "new": "B\nC\nX"})
    assert d.added == 3 and d.removed == 2 and not d.error
    assert "[Edit OK]" in edit_file("c.txt", "b\nc", "B\nC\nX")
    assert p.read_bytes() == b"a\r\nB\r\nC\r\nX\r\nd\r\n"


def test_crlf_old_with_crlf_matches(tmp_path, monkeypatch):
    from aihub_code.engine.file_ops import edit_file
    _setup(tmp_path, monkeypatch)
    p = tmp_path / "c.txt"
    p.write_bytes(b"a\r\nb\r\nc\r\n")
    assert not preview("edit_file", {"path": "c.txt", "old": "a\r\nb", "new": "x"}).error
    assert "[Edit OK]" in edit_file("c.txt", "a\r\nb", "x")
    assert p.read_bytes() == b"x\r\nc\r\n"


def test_latin1_edit_real_preserves_bytes(tmp_path, monkeypatch):
    from aihub_code.engine.file_ops import edit_file
    _setup(tmp_path, monkeypatch)
    p = tmp_path / "l.txt"
    p.write_bytes("caf\xe9\nold\nna\xefve\n".encode("latin-1"))
    assert preview("edit_file", {"path": "l.txt", "old": "old", "new": "n\xfcw"}).added == 1
    assert "[Edit OK]" in edit_file("l.txt", "old", "n\xfcw")
    assert p.read_bytes() == "caf\xe9\nn\xfcw\nna\xefve\n".encode("latin-1")


def test_plus_plus_line_counts(tmp_path, monkeypatch):
    d = unified_diff("a\n", "a\n++i\n", str(tmp_path / "f"))
    assert d.added == 1
    d = unified_diff("a\n--x\n", "a\n", str(tmp_path / "f"))
    assert d.removed == 1


def test_write_summary_reports_new_size(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    (tmp_path / "a.txt").write_text("small")
    d = preview("write_file", {"path": "a.txt", "content": "x" * 1_200_000})
    assert "1200000 bytes" in d.text


def test_write_file_no_newline_translation(tmp_path, monkeypatch):
    from aihub_code.engine.file_ops import write_file
    _setup(tmp_path, monkeypatch)
    write_file("w.txt", "a\r\nb\n")
    assert (tmp_path / "w.txt").read_bytes() == b"a\r\nb\n"


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")
@pytest.mark.parametrize("name,args", [
    ("edit_file", {"old": "a", "new": "b"}),
    ("write_file", {"content": "x"}),
])
def test_preview_refuses_special_files(tmp_path, monkeypatch, name, args):
    import threading
    _setup(tmp_path, monkeypatch)
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("d", preview(name, {"path": "pipe", **args})),
                         daemon=True)
    t.start()
    t.join(3)
    try:
        assert not t.is_alive(), "preview blocked on a FIFO"
        assert "not a regular file" in out["d"].error
    finally:
        try:
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:
            pass
