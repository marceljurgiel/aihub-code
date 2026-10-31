"""Model fit across many machines: sanity invariants for installed_fit.add_fit.

add_fit rates every installed local model with aihub.fit.assess against
aihub.target.current(). These tests build the machine two ways:

  * through the real pipeline — aihub.hardware.get_gpu_info/get_ram_info
    faked so target.current() runs _local_target, or a fake servers.json
    profile under the test HOME so it runs _server_target;
  * directly as aihub.target.Target(...), for ladders (more VRAM, more RAM)
    and for machines the pipeline cannot describe yet (Apple silicon).

Pure computation: nothing talks to Ollama. tests/conftest.py points HOME at
a temp dir before aihub is imported, so servers.json here is never the
user's real one.
"""
from __future__ import annotations

import contextlib
import json
import math
import os
import pwd
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Union

import pytest

from aihub import fit as fit_mod
from aihub import hardware
from aihub import target as target_mod
from aihub.config import CONFIG_DIR, config
from aihub.target import DEFAULT_BW, Target

from aihub_code.installed_fit import add_fit

# Never touch the real ~/.aihub (the fake servers.json is written below).
assert Path(CONFIG_DIR).resolve() != Path(pwd.getpwuid(os.getuid()).pw_dir).resolve() / ".aihub"

RANK = {"none": 0, "cpu": 1, "partial": 2, "gpu": 3}
SERVER_URL = "http://203.0.113.7:11434"          # TEST-NET: never local, never contacted
LOCAL_URL = "http://localhost:11434"
TOOLS = ["completion", "tools"]


# ── models, as models.installed rows ─────────────────────────────────────────

def _row(name, size_gb, params, caps, cloud=False):
    return {"name": name, "size_gb": size_gb, "cloud": cloud, "params": params,
            "capabilities": caps, "status": "free" if cloud else ""}


MODELS = [
    _row("embeddinggemma:300m", 0.62, "308M", ["embedding"]),
    _row("llama3.2:1b", 1.3, "1.2B", TOOLS),
    _row("llama3.2:3b", 2.0, "3.2B", TOOLS),
    _row("lfm2.5:8b", 4.8, "8.5B", ["completion"]),          # MoE, ~1B active
    _row("llama3.1:8b", 4.9, "8.0B", TOOLS),
    _row("qwen3:8b", 5.2, "8.2B", TOOLS),
    _row("gemma3:12b", 8.1, "12.2B", ["completion", "vision"]),
    _row("qwen3:14b", 9.3, "14.8B", TOOLS),
    _row("gemma3:27b", 17.4, "27.4B", ["completion", "vision"]),
    _row("qwen3:32b", 20.2, "32.8B", TOOLS),
    _row("llama3.3:70b", 42.5, "70.6B", TOOLS),
    _row("gemma4:cloud", 0.0, "33B", TOOLS, cloud=True),
]
LOCAL_MODELS = [m for m in MODELS if not m["cloud"]]
# Embedding models get a placement but no speed or score (installed_fit).
CHAT_MODELS = [m for m in LOCAL_MODELS if "embedding" not in m["capabilities"]]
DENSE_BY_SIZE = sorted((m for m in CHAT_MODELS if m["name"] != "lfm2.5:8b"), key=lambda m: m["size_gb"])
BY_NAME = {m["name"]: m for m in MODELS}


# ── machines ─────────────────────────────────────────────────────────────────

def _gpu(vendor: str, model: str, vram_gb: float) -> Dict:
    mb = int(vram_gb * 1024)
    return {"vendor": vendor, "model": model, "vram_total_mb": mb, "vram_free_mb": mb}


NO_GPU = _gpu("Unknown", "No dedicated GPU detected", 0)   # also what macOS gets today


@dataclass(frozen=True)
class Local:
    """This computer runs Ollama: what aihub.hardware reports."""
    gpu: Dict
    ram_gb: float
    setting: float = 0.0          # config.ollama_gpu_memory_gb


@dataclass(frozen=True)
class Server:
    """A remote Ollama: what AIhub learned about it in servers.json."""
    profile: Dict = field(default_factory=dict)
    setting: float = 0.0


Machine = Union[Local, Server, Target]

LOCAL: Dict[str, Local] = {
    "cpu 8G": Local(NO_GPU, 8),
    "cpu 16G": Local(NO_GPU, 16),
    "cpu 32G": Local(NO_GPU, 32),
    "nv 6G/16G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 2060", 6), 16),
    "nv 8G/16G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 3070", 8), 16),
    "nv 12G/32G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 3060", 12), 32),
    "nv 16G/32G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 4060 Ti", 16), 32),
    "nv 24G/32G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 3090", 24), 32),
    "nv 24G/64G": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 4090", 24), 64),
    "amd 8G/16G": Local(_gpu("AMD", "Radeon RX 6600", 8), 16),
    "amd 16G/32G": Local(_gpu("AMD", "Radeon RX 7800 XT", 16), 32),
    "intel igpu/16G": Local(_gpu("Intel", "Intel Iris Xe Graphics", 0), 16),   # lspci: no VRAM
    "intel arc 16G/32G": Local(_gpu("Intel", "Intel Arc A770", 16), 32),     # Windows wmi
    "mac 16G (detected)": Local(NO_GPU, 16),                                # no macOS branch
    "nv 12G, setting 8": Local(_gpu("NVIDIA", "NVIDIA GeForce RTX 3060", 12), 32, setting=8),
    "mac 16G, setting 12": Local(NO_GPU, 16, setting=12),
}
CPU_ONLY = ["cpu 8G", "cpu 16G", "cpu 32G", "intel igpu/16G", "mac 16G (detected)"]


def _apple(mem_gb: int) -> Target:
    """Apple silicon as the code seems to intend it (DEFAULT_BW["apple"],
    shared memory). Built by hand: _local_target has no Apple path.
    Metal can wire ~75% of unified memory; ram_gb is the whole of it."""
    return Target("local", f"Apple M-series {mem_gb} GB", round(mem_gb * 0.75, 1), "assumed",
                  float(mem_gb), DEFAULT_BW["apple"], "estimated", True)


APPLE: Dict[str, Target] = {f"apple {n}G": _apple(n) for n in (8, 16, 32, 64, 128)}


def _sample(tps, size_gb, weights_gb, on_gpu=True, moe=False):
    return {"tps": tps, "size_gb": size_gb, "weights_gb": weights_gb, "moe": moe, "on_gpu": on_gpu, "at": 0}


# Shaped like the real ~/.aihub profile of a Radeon 680M iGPU server
# (anonymised): dense 3B–9B models at ~6.5 tok/s for 8B, MoE lfm2.5 at 28.7.
IGPU_PROFILE = {
    "bw_samples": [33.0, 39.4, 38.8, 42.1, 41.7, 40.6, 33.5, 38.4, 31.0, 30.1, 37.8, 38.4],
    "vram_full_max_gb": 6.9,
    "models": {
        "llama3.2:3b": _sample(22.4, 2.16, 1.88),
        "qwen3:8b": {"tps": 6.5, "size_gb": 6.89, "on_gpu": True, "at": 0},   # pre-weights_gb entry
        "lfm2.5:8b": _sample(28.7, 5.33, 4.8, moe=True),
        "qwen3.5:9b": _sample(6.3, 6.02, 6.15),
        "qwen2.5-coder:7b": _sample(6.9, 5.98, 4.36),
    },
}
NV_FULL_PROFILE = {"vram_full_max_gb": 11.2,
                   "models": {"llama3.1:8b": _sample(95.0, 5.6, 4.9)}}
# A 16 GB discrete card: one model fully on the GPU (70 tok/s × 4.9 GB = 343
# GB/s), two partly offloaded ones (89 and 182 GB/s "bandwidth").
NV_PARTIAL_PROFILE = {
    "vram_partial_gb": 15.1,
    "models": {
        "llama3.1:8b": _sample(70.0, 5.6, 4.9),
        "qwen3:32b": _sample(9.0, 21.5, 20.2, on_gpu=False),
        "llama3.3:70b": _sample(2.1, 44.0, 42.5, on_gpu=False),
    },
}

SERVERS: Dict[str, Server] = {
    "srv new (assumed)": Server(),
    "srv igpu (learned)": Server(IGPU_PROFILE),
    "srv nv full-max 11G": Server(NV_FULL_PROFILE),
    "srv nv partial 15G": Server(NV_PARTIAL_PROFILE),
    "srv partial, setting 24": Server(NV_PARTIAL_PROFILE, setting=24),
}

ALL: Dict[str, Machine] = {**LOCAL, **APPLE, **SERVERS}


@contextlib.contextmanager
def machine(spec: Machine, measured: Optional[Dict[str, float]] = None) -> Iterator[Target]:
    """Make target.current() describe `spec`; yields that Target.
    `measured` = {model: tok/s} replaces servers.json speeds ({} = none);
    None keeps whatever the (fake) servers.json says."""
    store = Path(target_mod._store_path())
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(config, "ollama_gpu_memory_gb", 0.0)
        if isinstance(spec, Target):
            mp.setattr(target_mod, "current", lambda: spec)
            mp.setattr(config, "ollama_api_url", LOCAL_URL)
        elif isinstance(spec, Local):
            mp.setattr(hardware, "get_gpu_info", lambda: dict(spec.gpu))
            mp.setattr(hardware, "get_ram_info", lambda: {"total_gb": spec.ram_gb,
                                                          "available_gb": spec.ram_gb / 2, "percent_used": 50.0})
            mp.setattr(config, "ollama_api_url", LOCAL_URL)
            mp.setattr(config, "ollama_gpu_memory_gb", spec.setting)
        else:
            store.parent.mkdir(parents=True, exist_ok=True)
            store.write_text(json.dumps({SERVER_URL: spec.profile}), encoding="utf-8")
            mp.setattr(config, "ollama_api_url", SERVER_URL)
            mp.setattr(config, "ollama_gpu_memory_gb", spec.setting)
        if measured is not None:
            mp.setattr(target_mod, "measured_tps", lambda url, name: measured.get(name))
        try:
            yield target_mod.current()
        finally:
            store.unlink(missing_ok=True)


def rate(spec: Machine, models: Optional[List[Dict]] = None,
         measured: Optional[Dict[str, float]] = None) -> Dict[str, Dict]:
    """add_fit over `models` on `spec`: {name: fit} for the local ones.
    Estimates only, unless `measured` says otherwise."""
    with machine(spec, {} if measured is None else measured):
        out = add_fit({"models": [dict(m) for m in (models or MODELS)], "recent": []})
    return {m["name"]: m["fit"] for m in out["models"] if "fit" in m}


def _discrete(vram, ram=32.0, bw=DEFAULT_BW["nvidia"]) -> Target:
    return Target("local", "ladder", float(vram), "detected", float(ram), bw, "estimated", False)


def _shared(vram, ram=32.0, bw=DEFAULT_BW["shared"]) -> Target:
    return Target("local", "ladder", float(vram), "setting", float(ram), bw, "estimated", True)


# ── the pipeline builds the machine we meant ─────────────────────────────────

@pytest.mark.parametrize("name, vram, basis, bw, shared", [
    ("cpu 16G", 0.0, "none", DEFAULT_BW["cpu"], True),
    ("nv 12G/32G", 12.0, "detected", DEFAULT_BW["nvidia"], False),
    ("amd 8G/16G", 8.0, "detected", DEFAULT_BW["amd"], False),
    ("intel igpu/16G", 0.0, "none", DEFAULT_BW["cpu"], True),
    ("intel arc 16G/32G", 16.0, "detected", DEFAULT_BW["shared"], True),   # see report: Arc is discrete
    ("mac 16G (detected)", 0.0, "none", DEFAULT_BW["cpu"], True),
    ("nv 12G, setting 8", 8.0, "setting", DEFAULT_BW["nvidia"], False),
    ("mac 16G, setting 12", 12.0, "setting", DEFAULT_BW["shared"], True),
])
def test_local_pipeline_maps_hardware_to_a_target(name, vram, basis, bw, shared):
    with machine(LOCAL[name]) as t:
        assert (t.where, t.vram_gb, t.vram_basis, t.bw_eff, t.shared_memory) == ("local", vram, basis, bw, shared)
        assert t.ram_gb == LOCAL[name].ram_gb


@pytest.mark.parametrize("name, vram, basis, bw, bw_basis, shared", [
    ("srv new (assumed)", 8.0, "assumed", DEFAULT_BW["shared"], "estimated", True),
    ("srv igpu (learned)", 8.0, "learned", 40.4, "measured", True),      # median of dense models
    ("srv nv full-max 11G", 11.2, "learned", 465.5, "measured", False),
    ("srv nv partial 15G", 15.1, "learned", 181.8, "measured", False),
    ("srv partial, setting 24", 24.0, "setting", 181.8, "measured", False),
])
def test_server_pipeline_learns_a_target(name, vram, basis, bw, bw_basis, shared):
    with machine(SERVERS[name]) as t:
        assert (t.where, t.vram_gb, t.vram_basis, t.bw_eff, t.bw_basis, t.shared_memory) == (
            "server", vram, basis, bw, bw_basis, shared)
        assert t.ram_gb == 0.0                    # a server's RAM is never known


@pytest.mark.xfail(strict=True, reason=(
    "aihub/target.py _server_target: the bandwidth median includes partly offloaded runs "
    "(on_gpu False), whose tok/s is CPU-bound; the 16 GB card's 343 GB/s is learned as 181.8."))
def test_server_bandwidth_comes_from_runs_fully_on_the_gpu():
    with machine(SERVERS["srv nv partial 15G"]) as t:
        assert t.bw_eff == pytest.approx(343.0, rel=0.05)


@pytest.mark.xfail(strict=True, reason=(
    "aihub/hardware.py get_gpu_info has no macOS/Apple branch and aihub/target.py _local_target "
    "never uses DEFAULT_BW['apple']: an M-series Mac is rated as a 25 GB/s CPU-only box."))
def test_apple_silicon_is_not_rated_as_cpu_only():
    with machine(Local(_gpu("Apple", "Apple M2", 0), 16)) as t:
        assert t.bw_eff == DEFAULT_BW["apple"]
    assert rate(Local(_gpu("Apple", "Apple M2", 0), 16))["llama3.1:8b"]["placement"] != "cpu"


# ── invariants ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", CPU_ONLY)
def test_cpu_only_machines_never_say_gpu(name):
    for model, f in rate(LOCAL[name]).items():
        assert f["placement"] in ("cpu", "none"), (name, model, f)


@pytest.mark.parametrize("kind", ["discrete", "shared"])
@pytest.mark.parametrize("model", [m["name"] for m in CHAT_MODELS])
def test_more_vram_never_gives_a_worse_placement_or_speed(kind, model):
    make = _discrete if kind == "discrete" else _shared
    ladder = [0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 80]
    fits = [rate(make(v), [BY_NAME[model]])[model] for v in ladder]
    for (v0, a), (v1, b) in zip(zip(ladder, fits), zip(ladder[1:], fits[1:])):
        assert RANK[b["placement"]] >= RANK[a["placement"]], (model, v0, a, v1, b)
        assert b["est_tps"] >= a["est_tps"], (model, v0, a, v1, b)


@pytest.mark.parametrize("vram", [0, 8])
@pytest.mark.parametrize("model", [m["name"] for m in CHAT_MODELS])
def test_more_ram_never_gives_a_worse_placement_or_speed(vram, model):
    ladder = [0, 4, 8, 16, 24, 32, 64, 128]
    fits = [rate(_discrete(vram, ram=r), [BY_NAME[model]])[model] for r in ladder]
    for a, b in zip(fits, fits[1:]):
        assert RANK[b["placement"]] >= RANK[a["placement"]]
        assert b["est_tps"] >= a["est_tps"]


@pytest.mark.parametrize("model", [m["name"] for m in CHAT_MODELS])
def test_more_bandwidth_never_makes_a_model_slower(model):
    for make in (_discrete, _shared):
        tps = [rate(make(8, bw=bw), [BY_NAME[model]])[model]["est_tps"] for bw in (20, 35, 100, 250, 500, 1000)]
        assert tps == sorted(tps), (model, tps)


@pytest.mark.parametrize("name", list(ALL))
def test_a_bigger_model_is_never_faster_on_the_same_machine(name):
    fits = rate(ALL[name], DENSE_BY_SIZE)
    ordered = [fits[m["name"]] for m in DENSE_BY_SIZE]
    for small, big in zip(ordered, ordered[1:]):
        assert big["est_tps"] <= small["est_tps"], (name, small, big)
        assert RANK[big["placement"]] <= RANK[small["placement"]], (name, small, big)


@pytest.mark.parametrize("name", list(ALL))
def test_every_rating_is_well_formed(name):
    with machine(ALL[name], {}) as t:
        pass
    for model, f in rate(ALL[name]).items():
        if "embedding" in BY_NAME[model]["capabilities"]:
            assert f["kind"] == "embedding" and f["placement"] in RANK
            assert not {"est_tps", "score", "score_abs", "basis"} & set(f), (model, f)
            continue
        assert set(f) >= {"fits", "placement", "est_tps", "need_gb", "basis", "score", "score_abs"}
        assert f["placement"] in RANK and 0 <= f["score"] <= 100 and 0 <= f["score_abs"] <= 100
        assert math.isfinite(f["est_tps"]) and f["basis"] == "estimated"
        assert f["fits"] == (f["placement"] != "none") == (f["est_tps"] > 0)
        # GPU exactly when the model and its runtime fit in VRAM.
        assert (f["placement"] == "gpu") == (bool(t.vram_gb) and f["need_gb"] <= t.vram_gb + 0.05), (model, f)


def test_shared_memory_offload_costs_little():
    """shared_memory's intent: an iGPU/APU spilling layers to the CPU reads
    the same RAM, so partial ≈ GPU speed (×0.85), unlike a discrete card."""
    for model in ("qwen3:14b", "gemma3:27b"):
        row = [BY_NAME[model]]
        on_gpu = rate(_shared(48, bw=100), row)[model]
        shared = rate(_shared(6, bw=100), row)[model]
        discrete = rate(_discrete(6, bw=100), row)[model]
        assert on_gpu["placement"] == "gpu" and shared["placement"] == discrete["placement"] == "partial"
        assert shared["est_tps"] == pytest.approx(on_gpu["est_tps"] * 0.85, abs=0.1)
        assert shared["est_tps"] > discrete["est_tps"]
    # Fully on the GPU the two are the same.
    assert rate(_shared(12, bw=100))["llama3.1:8b"]["est_tps"] == rate(_discrete(12, bw=100))["llama3.1:8b"]["est_tps"]


@pytest.mark.parametrize("name, model", [
    ("cpu 8G", "qwen3:14b"),
    ("cpu 16G", "gemma3:27b"),
    ("cpu 32G", "llama3.3:70b"),
    ("nv 8G/16G", "gemma3:27b"),
    ("nv 24G/32G", "llama3.3:70b"),
    ("mac 16G (detected)", "gemma3:27b"),
    ("apple 32G", "llama3.3:70b"),
    ("srv new (assumed)", "gemma3:27b"),
    ("srv nv partial 15G", "llama3.3:70b"),
])
def test_a_model_that_cannot_fit_says_so(name, model):
    f = rate(ALL[name])[model]
    assert (f["fits"], f["placement"], f["est_tps"], f["score"], f["score_abs"], f["basis"]) == (
        False, "none", 0.0, 0, 0, "estimated")


def _physical_gb(spec: Local) -> float:
    shared = spec.gpu["vram_total_mb"] == 0 or spec.gpu["vendor"] == "Intel"
    return spec.ram_gb if shared else spec.ram_gb + spec.gpu["vram_total_mb"] / 1024


@pytest.mark.parametrize("spec, model", [
    (Local(NO_GPU, 8), "llama3.1:8b"),
    (Local(_gpu("NVIDIA", "RTX 3070", 8), 16), "gemma3:12b"),
    (Local(NO_GPU, 16), "qwen3:14b"),
    pytest.param(Local(NO_GPU, 4), "llama3.1:8b", marks=pytest.mark.xfail(strict=True, reason=(
        "aihub/fit.py estimate(): spare_ram = max(ram_gb * 0.6, 8.0) — the 8 GB floor exceeds a "
        "4 GB machine's whole RAM, so a 5.7 GB need 'fits' on CPU."))),
    pytest.param(Local(NO_GPU, 16, setting=12), "gemma3:27b", marks=pytest.mark.xfail(strict=True, reason=(
        "aihub/fit.py estimate(): on shared memory the GPU's share is system RAM, but capacity is "
        "vram + 0.6·ram — counted twice: an 18.9 GB need 'fits' a 16 GB Mac with the GPU setting."))),
    pytest.param(Local(NO_GPU, 8, setting=6), "qwen3:14b", marks=pytest.mark.xfail(strict=True, reason=(
        "aihub/fit.py estimate(): shared-memory double count plus the 8 GB floor: a 10.4 GB need "
        "'fits' an 8 GB machine."))),
])
def test_nothing_fits_beyond_the_machines_physical_memory(spec, model):
    f = rate(spec)[model]
    if f["fits"]:
        assert f["need_gb"] <= _physical_gb(spec), (spec, model, f)


def test_measured_speed_replaces_the_estimate_only_when_the_model_fits():
    spec = LOCAL["nv 8G/16G"]
    measured = {"llama3.1:8b": 61.0, "qwen3:14b": 7.5, "llama3.3:70b": 1.2, "qwen3:8b": 0.0}
    est, got = rate(spec), rate(spec, measured=measured)
    assert (got["llama3.1:8b"]["est_tps"], got["llama3.1:8b"]["basis"]) == (61.0, "measured")
    assert got["llama3.1:8b"]["placement"] == est["llama3.1:8b"]["placement"] == "gpu"
    assert (got["qwen3:14b"]["est_tps"], got["qwen3:14b"]["basis"]) == (7.5, "measured")   # partial
    # Doesn't fit by the estimate, but it ran here: it fits, at its measured
    # speed, partly on the GPU when the profile doesn't say it was all on it.
    assert est["llama3.3:70b"]["fits"] is False
    assert (got["llama3.3:70b"]["fits"], got["llama3.3:70b"]["placement"], got["llama3.3:70b"]["est_tps"],
            got["llama3.3:70b"]["basis"]) == (True, "partial", 1.2, "measured")
    # A zero "measurement" is no measurement.
    assert got["qwen3:8b"] == est["qwen3:8b"]
    # The rest are untouched.
    assert got["llama3.2:3b"] == est["llama3.2:3b"]


def test_a_server_profile_supplies_measured_speeds():
    with machine(SERVERS["srv igpu (learned)"]):
        out = add_fit({"models": [dict(m) for m in MODELS]})
    by = {m["name"]: m.get("fit") for m in out["models"]}
    assert (by["llama3.2:3b"]["est_tps"], by["llama3.2:3b"]["basis"]) == (22.4, "measured")
    assert (by["lfm2.5:8b"]["est_tps"], by["lfm2.5:8b"]["basis"]) == (28.7, "measured")
    assert by["llama3.1:8b"]["basis"] == "estimated"
    assert out["target"]["where"] == "server"


@pytest.mark.parametrize("name", ["nv 12G/32G", "cpu 8G", "srv igpu (learned)", "apple 16G"])
def test_cloud_and_sizeless_rows_get_no_fit(name):
    rows = MODELS + [_row("broken:latest", 0.0, "7B", TOOLS)]
    with machine(ALL[name], {}):
        out = add_fit({"models": [dict(m) for m in rows]})
    by = {m["name"]: m for m in out["models"]}
    assert "fit" not in by["gemma4:cloud"] and "fit" not in by["broken:latest"]
    assert by["gemma4:cloud"] == BY_NAME["gemma4:cloud"]
    assert all("fit" in by[m["name"]] for m in LOCAL_MODELS)


def test_add_fit_keeps_order_and_odd_rows():
    rows = [
        _row("odd-params:latest", 3.0, "about 7B", TOOLS),    # unreadable label → params 0
        {"name": "no-caps:latest", "size_gb": "4.1", "cloud": False},   # size as text, no caps
        *MODELS[::-1],
    ]
    with machine(LOCAL["nv 12G/32G"], {}):
        out = add_fit({"models": [dict(r) for r in rows], "recent": ["x"]})
    assert [m["name"] for m in out["models"]] == [r["name"] for r in rows]
    assert out["recent"] == ["x"] and out["target"]["label"].endswith("RTX 3060")
    odd = out["models"][0]["fit"]
    assert odd["fits"] and odd["score_abs"] <= 2           # params 0 → capability ~0.01
    assert out["models"][1]["fit"]["placement"] == "gpu"


@pytest.mark.parametrize("bad", [
    {"name": "x", "size_gb": "big", "cloud": False},      # float("big")
    {"size_gb": 4.0, "cloud": False},                     # no name
    "not a dict",
])
def test_add_fit_never_raises_and_a_bad_row_stays_as_given(bad):
    src = {"models": [dict(MODELS[2]), bad, dict(MODELS[4])], "recent": []}
    with machine(LOCAL["nv 12G/32G"], {}):
        out = add_fit(src)
    assert out["models"][1] == bad          # the bad row, untouched
    assert "fit" in out["models"][0] and "fit" in out["models"][2]   # the others still rated


# ── plausibility against real-world speeds ───────────────────────────────────
# Bands from common llama.cpp/Ollama numbers for q4_K_M at short context.

@pytest.mark.parametrize("name, model, lo, hi", [
    ("cpu 16G", "llama3.1:8b", 3, 8),                 # dual-channel DDR4/DDR5 desktop
    ("cpu 16G", "llama3.2:3b", 8, 20),
    ("nv 8G/16G", "llama3.1:8b", 40, 90),             # RTX 3070
    ("nv 12G/32G", "llama3.1:8b", 40, 70),            # RTX 3060 12 GB
    ("nv 24G/64G", "llama3.3:70b", 0.5, 4),           # 4090 + RAM offload: slow
    ("apple 16G", "llama3.1:8b", 15, 45),             # M-series Pro-class, by hand
    ("srv igpu (learned)", "qwen3:8b", 5, 9),         # the real server measured 6.5
    pytest.param("nv 24G/64G", "llama3.1:8b", 90, 160, marks=pytest.mark.xfail(strict=True, reason=(
        "aihub/target.py DEFAULT_BW['nvidia'] = 250 GB/s for every NVIDIA card: an RTX 4090 "
        "(~1 TB/s) is rated like an RTX 3060, ~51 tok/s for 8B q4 instead of ~100–140."))),
    pytest.param("mac 16G (detected)", "llama3.1:8b", 15, 45, marks=pytest.mark.xfail(strict=True, reason=(
        "aihub/hardware.py + target.py: no Apple path, a Mac is a 25 GB/s CPU box (~5 tok/s)."))),
    ("srv igpu (learned)", "lfm2.5:8b", 14, 60),     # MoE: rated by its ~1.5B active (measured 28.7)
])
def test_estimates_are_in_a_plausible_band(name, model, lo, hi):
    f = rate(ALL[name])[model]
    assert lo <= f["est_tps"] <= hi, (name, model, f)


def matrix(specs: Optional[Dict[str, Machine]] = None) -> List[Dict]:
    """Configuration × model → fit, for the report (estimates only)."""
    rows = []
    for name, spec in (specs or ALL).items():
        with machine(spec, {}) as t:
            pass
        for model, f in rate(spec).items():
            rows.append({"config": name, "model": model, "vram": t.vram_gb, "bw": t.bw_eff,
                         "shared": t.shared_memory, **f})
    return rows


def test_the_whole_matrix_rates_every_local_model():
    rows = matrix()
    assert len(rows) == len(ALL) * len(LOCAL_MODELS)
