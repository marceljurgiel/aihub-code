"""models.installed carries a fit (where it runs, how fast) for local models."""
from __future__ import annotations

import pytest

from aihub_code import bridge, installed_fit


class _Target:
    """A server with an 8 GB GPU at 40 GB/s (aihub.target.Target's fields)."""
    where, label, vram_gb, vram_basis, ram_gb, bw_eff, bw_basis, shared_memory = (
        "server", "server x", 8.0, "learned", 0.0, 40.0, "measured", True)

    def to_dict(self):
        return {"where": self.where, "label": self.label, "vram_gb": self.vram_gb}


@pytest.fixture
def server(monkeypatch):
    from aihub import target
    monkeypatch.setattr(target, "current", lambda: _Target())
    monkeypatch.setattr(target, "measured_tps", lambda url, name: 24.0 if name == "llama3.2:3b" else None)


def _installed():
    return {"models": [
        {"name": "llama3.2:3b", "size_gb": 1.9, "cloud": False, "params": "3.2B", "capabilities": ["tools"]},
        {"name": "lfm2.5:8b", "size_gb": 4.8, "cloud": False, "params": "8.5B", "capabilities": []},
        {"name": "huge:70b", "size_gb": 40.0, "cloud": False, "params": "70B", "capabilities": []},
        {"name": "gemma4:cloud", "size_gb": 0.0, "cloud": True, "status": "free", "params": "33B"},
    ], "recent": []}


def test_local_models_get_placement_and_speed(server):
    out = installed_fit.add_fit(_installed())
    by = {m["name"]: m for m in out["models"]}
    assert by["llama3.2:3b"]["fit"]["placement"] == "gpu"
    assert by["llama3.2:3b"]["fit"]["est_tps"] == 24.0          # measured wins
    assert by["llama3.2:3b"]["fit"]["basis"] == "measured"
    assert by["lfm2.5:8b"]["fit"]["fits"] is True
    assert by["lfm2.5:8b"]["fit"]["basis"] == "estimated"
    assert by["lfm2.5:8b"]["fit"]["est_tps"] > 0
    assert by["huge:70b"]["fit"]["fits"] is False
    assert "fit" not in by["gemma4:cloud"]                         # cloud: nothing to fit
    assert out["target"]["label"] == "server x"


def test_params_are_read_from_the_card_label():
    assert installed_fit.params_b("8.5B") == 8.5
    assert installed_fit.params_b("308M") == 0.308
    assert installed_fit.params_b("") == 0.0
    assert installed_fit.params_b("big") == 0.0


def test_a_failing_fit_leaves_the_list_as_aihub_gave_it(monkeypatch):
    from aihub import target

    def boom():
        raise RuntimeError("no profile")

    monkeypatch.setattr(target, "current", boom)
    src = _installed()
    out = installed_fit.add_fit(src)
    assert [m["name"] for m in out["models"]] == [m["name"] for m in src["models"]]
    assert all("fit" not in m for m in out["models"])


def test_the_bridge_serves_models_installed_with_fit(server, monkeypatch):
    lines = []
    monkeypatch.setattr(bridge, "_send", lambda obj: lines.append(obj))
    from aihub import bridge as ab
    monkeypatch.setitem(ab._ONESHOT, "models.installed", lambda p: _installed())
    bridge._run(5, "models.installed", {})
    data = lines[-1]["data"]
    assert lines[-1]["done"] is True
    assert {m["name"]: "fit" in m for m in data["models"]} == {
        "llama3.2:3b": True, "lfm2.5:8b": True, "huge:70b": True, "gemma4:cloud": False}


# ── MoE, measured-but-none, one bad row, embedding models ─────────────────────

def _local(name, size, params, caps=("tools",)):
    return {"name": name, "size_gb": size, "cloud": False, "params": params, "capabilities": list(caps)}


def test_active_params_come_from_the_tag_the_catalog_or_known_moe_families():
    assert installed_fit.active_b("qwen3:30b-a3b") == 3.0
    assert installed_fit.active_b("qwen3-coder:30b", {"qwen3-coder": {"30b-a3b-q4_K_M": {}}}) == 3.0
    assert installed_fit.active_b("gpt-oss:20b") == 3.6
    assert installed_fit.active_b("lfm2.5:8b") == 1.5
    assert installed_fit.active_b("llama3.2:3b") is None
    assert installed_fit.active_b("qwen3:8b") is None            # dense size of a MoE-mixed family


def test_a_moe_model_is_rated_by_its_active_params(server):
    out = installed_fit.add_fit({"models": [_local("lfm2.5:8b", 4.8, "8.5B"), _local("dense:8b", 4.8, "8.5B")]})
    moe, dense = (m["fit"] for m in out["models"])
    assert moe["est_tps"] > 2.5 * dense["est_tps"]               # ~1.5B active read per token


def test_a_model_measured_on_this_machine_fits_whatever_the_estimate(monkeypatch):
    from aihub import target

    class Tiny(_Target):
        vram_gb = 2.0

    monkeypatch.setattr(target, "current", lambda: Tiny())
    monkeypatch.setattr(target, "measured_tps", lambda url, name: 6.5)
    monkeypatch.setattr(installed_fit, "_measured_on_gpu", lambda url, name: False)
    f = installed_fit.add_fit({"models": [_local("qwen3:14b", 30.0, "14B")]})["models"][0]["fit"]
    assert (f["fits"], f["placement"], f["est_tps"], f["basis"]) == (True, "partial", 6.5, "measured")


def test_one_bad_row_does_not_take_the_fit_from_the_others(server):
    out = installed_fit.add_fit({"models": [
        {"name": "odd", "size_gb": "big", "cloud": False},
        _local("llama3.2:3b", 1.9, "3.2B"),
    ]})
    assert "fit" not in out["models"][0]
    assert out["models"][1]["fit"]["placement"] == "gpu"


def test_an_embedding_model_gets_a_placement_but_no_speed_or_score(server):
    f = installed_fit.add_fit({"models": [_local("embeddinggemma:300m", 0.6, "308M", ["embedding"])]})["models"][0]["fit"]
    assert f["kind"] == "embedding" and f["fits"] is True and f["placement"] == "gpu"
    assert "est_tps" not in f and "score" not in f
