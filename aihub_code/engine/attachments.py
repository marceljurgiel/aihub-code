"""Image attachments around a turn, safe against mid-turn compaction.

AIhub 1.5.0's `restore` maps an expanded message back to its original by
`id()`. A code turn compacts the wire list between rounds; a message dropped
there frees its address, a later message may get it, and `restore` would swap
that message for the old original. These wrappers keep each expanded message
alive (the map holds it) and swap only when the object is the very same one.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from aihub import attachments as _att

Originals = Dict[int, Tuple[Dict[str, Any], Dict[str, Any]]]


def expand(messages: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Originals]:
    """A copy of `messages` with image ids replaced by image data, and a map
    id(expanded) -> (expanded, original)."""
    wire, originals = _att.expand(messages)
    by_id = {id(m): m for m in wire}
    return wire, {i: (by_id[i], orig) for i, orig in originals.items() if i in by_id}


def restore(messages: List[Dict[str, Any]], originals: Originals) -> List[Dict[str, Any]]:
    out = []
    for m in messages:
        pair = originals.get(id(m))
        out.append(pair[1] if pair is not None and pair[0] is m else m)
    return out
