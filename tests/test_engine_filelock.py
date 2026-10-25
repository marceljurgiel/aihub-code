import os
import threading

import pytest

from aihub_code.engine.filelock import LockBusy, file_lock, try_file_lock


def test_try_lock_takes_a_free_lock_and_releases_it(tmp_path):
    p = str(tmp_path / "x.lock")
    with try_file_lock(p):
        pass
    with try_file_lock(p):
        pass


def test_try_lock_is_busy_while_another_handle_holds_it(tmp_path):
    p = str(tmp_path / "x.lock")
    with try_file_lock(p):
        with pytest.raises(LockBusy):
            with try_file_lock(p):
                pytest.fail("entered a held lock")
    with try_file_lock(p):      # free again
        pass


def test_try_lock_is_busy_while_file_lock_is_held_elsewhere(tmp_path):
    p = str(tmp_path / "x.lock")
    held, release = threading.Event(), threading.Event()

    def hold():
        with file_lock(p):
            held.set()
            release.wait(5)

    t = threading.Thread(target=hold, daemon=True)
    t.start()
    assert held.wait(5)
    try:
        with pytest.raises(LockBusy):
            with try_file_lock(p):
                pass
    finally:
        release.set()
        t.join(5)


def test_try_lock_creates_missing_directories(tmp_path):
    p = str(tmp_path / "a" / "b" / "x.lock")
    with try_file_lock(p):
        assert os.path.exists(p)
