"""Where each installed model runs on the machine behind Ollama, and how fast.

AIhub's models.installed lists the models; its Fit tab rates catalog models
with aihub.fit.assess. aihub-code puts the two together for the Installed
tab: the same assessment for every local model, from the size Ollama reports
and the parameter count on its card. Cloud models have nothing to fit. Reads
only AIhub's local caches (the target profile, the catalog) — no requests.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)

_UNITS = {"K": 1e-6, "M": 1e-3, "B": 1.0, "T": 1e3}

# MoE models whose Ollama tag doesn't say how many parameters are active
# (a tag like "30b-a3b" does). Billions active per token, from the models'
# own cards. Only what is read per token sets a MoE model's speed.
KNOWN_ACTIVE = {
    "gpt-oss:20b": 3.6, "gpt-oss:120b": 5.1,
    "lfm2:8b": 1.5, "lfm2.5:8b": 1.5,
    "qwen3:30b": 3.3, "qwen3:235b": 22.0,
    "qwen3-coder:30b": 3.3, "qwen3-coder:480b": 35.0,
    "deepseek-v3:671b": 37.0, "deepseek-r1:671b": 37.0,
    "mixtral:8x7b": 12.9, "mixtral:8x22b": 39.0,
}

_ACTIVE_TAG = re.compile(r"(?:^|-)a(\d+(?:\.\d+)?)b(?:-|$)", re.I)


def params_b(label: str) -> float:
    """Billions of parameters from a model card's label ("8.5B", "308M")."""
    m = re.fullmatch(r"\s*([\d.]+)\s*([KMBT])\s*", str(label or ""), re.I)
    if not m:
        return 0.0
    try:
        return round(float(m.group(1)) * _UNITS[m.group(2).upper()], 6)
    except ValueError:
        return 0.0


def active_b(name: str, variants: Optional[Dict[str, Dict[str, Any]]] = None) -> Optional[float]:
    """Billions of active parameters of a MoE model, None for a dense one (or
    one we can't tell). From the tag ("30b-a3b"), else a catalog variant of
    the same size that names it ("30b-a3b-q4_K_M" for "30b"), else
    KNOWN_ACTIVE. `variants`: family → {tag: …} from AIhub's catalog."""
    family, _, tag = name.partition(":")
    tag = tag or "latest"
    m = _ACTIVE_TAG.search(tag)
    if m:
        return float(m.group(1))
    size = tag.split("-")[0].lower()
    for vtag in (variants or {}).get(family, {}):
        vt = vtag.lower()
        if vt.startswith(size + "-"):
            m = _ACTIVE_TAG.search(vt)
            if m:
                return float(m.group(1))
    return KNOWN_ACTIVE.get(f"{family}:{size}")


def _catalog_variants() -> Dict[str, Dict[str, Any]]:
    try:
        from aihub import catalog
        return {m["name"]: m.get("variants") or {} for m in catalog.ollama_models()["models"]}
    except Exception:
        log.warning("could not read the model catalog", exc_info=True)
        return {}


def _measured_on_gpu(url: str, name: str) -> Optional[bool]:
    """Whether the last measured run of `name` sat fully on the GPU (AIhub's
    servers.json), None when unknown."""
    try:
        from aihub import target as target_mod
        m = target_mod._load().get(url, {}).get("models", {}).get(name)
        return bool(m["on_gpu"]) if m and "on_gpu" in m else None
    except Exception:
        return None


def _rate(m: Dict[str, Any], tgt, url: str, variants) -> Dict[str, Any]:
    from aihub import target as target_mod
    from aihub.fit import assess

    caps = m.get("capabilities") or []
    cand = {"name": m["name"], "params_b": params_b(m.get("params", "")),
            "active_b": active_b(m["name"], variants), "size_gb": float(m["size_gb"]),
            "updated": "", "pulls": 0, "capabilities": caps}
    measured = target_mod.measured_tps(url, m["name"])
    fit = assess(cand, tgt, measured)
    if measured and not fit["fits"]:
        # It ran here, so it fits, whatever the estimate says (an assumed
        # server size, an unknown server RAM): where it ran, at its speed.
        on_gpu = _measured_on_gpu(url, m["name"])
        fit = {**fit, "fits": True, "placement": "gpu" if on_gpu else "partial",
               "est_tps": measured, "basis": "measured"}
    if "embedding" in caps:
        # An embedding model doesn't generate: a speed or a chat score would
        # say nothing. Where it runs still matters.
        fit = {k: v for k, v in fit.items() if k not in ("est_tps", "score", "score_abs", "basis")}
        fit["kind"] = "embedding"
    return fit


def add_fit(result: Dict[str, Any]) -> Dict[str, Any]:
    """models.installed's answer with `fit` on each local model and the
    `target` it was rated for. Never raises: a row that can't be rated stays
    as AIhub gave it, and if the machine can't be profiled at all the whole
    answer does (the Installed tab then shows no fit)."""
    try:
        from aihub import target as target_mod
        from aihub.config import config

        tgt = target_mod.current()
        url = config.ollama_api_url
    except Exception:
        log.warning("could not profile the machine behind Ollama", exc_info=True)
        return result
    variants = _catalog_variants()
    models = []
    for m in result.get("models") or []:
        try:
            if not isinstance(m, dict) or m.get("cloud") or not m.get("size_gb"):
                models.append(m)
                continue
            models.append({**m, "fit": _rate(m, tgt, url, variants)})
        except Exception:
            log.warning("could not rate %r", m.get("name") if isinstance(m, dict) else m, exc_info=True)
            models.append(m)
    try:
        target = tgt.to_dict()
    except Exception:
        target = {}
    return {**result, "models": models, "target": target}
