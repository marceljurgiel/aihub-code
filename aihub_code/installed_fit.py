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
from typing import Any, Dict

log = logging.getLogger(__name__)

_UNITS = {"K": 1e-6, "M": 1e-3, "B": 1.0, "T": 1e3}


def params_b(label: str) -> float:
    """Billions of parameters from a model card's label ("8.5B", "308M")."""
    m = re.fullmatch(r"\s*([\d.]+)\s*([KMBT])\s*", str(label or ""), re.I)
    if not m:
        return 0.0
    try:
        return round(float(m.group(1)) * _UNITS[m.group(2).upper()], 6)
    except ValueError:
        return 0.0


def add_fit(result: Dict[str, Any]) -> Dict[str, Any]:
    """models.installed's answer with `fit` on each local model and the
    `target` it was rated for. Never raises: on any failure the answer is
    returned as AIhub gave it (the Installed tab then shows no fit)."""
    try:
        from aihub import target as target_mod
        from aihub.config import config
        from aihub.fit import assess

        tgt = target_mod.current()
        models = []
        for m in result.get("models") or []:
            if m.get("cloud") or not m.get("size_gb"):
                models.append(m)
                continue
            cand = {"name": m["name"], "params_b": params_b(m.get("params", "")), "active_b": None,
                    "size_gb": float(m["size_gb"]), "updated": "", "pulls": 0,
                    "capabilities": m.get("capabilities") or []}
            measured = target_mod.measured_tps(config.ollama_api_url, m["name"])
            models.append({**m, "fit": assess(cand, tgt, measured)})
        return {**result, "models": models, "target": tgt.to_dict()}
    except Exception:
        log.warning("could not rate the installed models", exc_info=True)
        return result
