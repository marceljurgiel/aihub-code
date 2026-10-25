"""Image ids <-> image data around a turn: restore must be identity-safe."""
import shutil

import pytest

from aihub import attachments as aihub_att
from aihub_code.engine import attachments as att

from .helpers import png_bytes


@pytest.fixture(autouse=True)
def clean():
    shutil.rmtree(aihub_att.att_dir(), ignore_errors=True)
    aihub_att._VISION_CACHE.clear()
    yield
    shutil.rmtree(aihub_att.att_dir(), ignore_errors=True)


def test_expand_then_restore_returns_the_originals():
    a = aihub_att.add_bytes(png_bytes(), "a.png")
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "look", "images": [a["id"]]}]
    wire, orig = att.expand(msgs)
    assert isinstance(wire[1]["images"][0], dict)           # data, not an id
    back = att.restore(wire, orig)
    assert back[1] is msgs[1] and back[1]["images"] == [a["id"]]


def test_restore_never_swaps_in_a_dropped_image_message():
    # Mid-turn compaction can drop the expanded copy of an image message; a
    # dict made later may get its address, and must not be swapped back.
    a = aihub_att.add_bytes(png_bytes(), "a.png")
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "old", "images": [a["id"]]}]
    wire, orig = att.expand(msgs)
    wire.pop(1)
    later = [{"role": "assistant", "content": f"r{i}"} for i in range(200)]
    back = att.restore(wire + later, orig)
    assert all(b is m for b, m in zip(back[1:], later))
    assert not any("images" in m for m in back)
