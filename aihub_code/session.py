"""A coding session of `aihub-code`: its history, mode, todos, rules and undo.

`run_turn` drives one turn through `aihub_code.engine.turn.drive_turn` with the session's
`CodeHooks` (code tools, approvals with "remember", compaction between tool
rounds, a checkpoint per turn). `SessionStore` keeps sessions as JSON next to
the project's other harness state, so they can be listed and resumed.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Tuple

from aihub.config import config
from aihub.tools.workdir import set_session_dir
from .engine.turn import TurnOutcome, drive_turn
from .checkpoints import CheckpointError, CheckpointStore, NothingToUndo, UndoPlan
from .compaction import SUMMARY_PREFIX, CompactionResult, Compactor, estimate_tokens, make_completer
from .diffs import preview
from .permissions import MODES, PLAN_DENIAL, PermissionEngine, RuleStore
from .project import ProjectInfo, detect, find_root, store_dir
from .prompt import build_code_prompt
from .todo import TodoList
from .tools import CodeToolRunner, code_tools_schema

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 60
TITLE_CHARS = 60
UNDONE_NOTE = "[The user undid the file changes of that turn.]"
OTHER_SESSION = "The last change on disk was made in another session; nothing was undone."
DENIED_INSTEAD = "[Denied by user] The user said instead: {}"
NO_APPROVER = "Refused: no one to approve this in a non-interactive run."
MCP_NOT_ENABLED = "Refused: that MCP tool is not enabled for this code session."

_ID_RE = re.compile(r"[A-Za-z0-9_-]+")

# One checkpoint store per project per process: sessions on the same project
# share its shadow repo and its list of turns, so undo can tell whose change is
# the last one on disk. Session ids handed out but not yet saved are reserved
# here too. Enough for one bridge process; a second process on the same project
# keeps its own list of turns.
_stores: Dict[Tuple[str, str], CheckpointStore] = {}
_reserved_ids: set = set()
_registry_lock = threading.Lock()


def _checkpoints(root: str, store: str) -> CheckpointStore:
    key = (os.path.realpath(root), os.path.abspath(store))
    with _registry_lock:
        cp = _stores.get(key)
        if cp is None:
            cp = _stores[key] = CheckpointStore(root, store)
        return cp


def _new_id(store: str) -> str:
    base = time.strftime("%Y%m%d-%H%M%S")
    sessions = os.path.join(store, "sessions")
    with _registry_lock:
        sid, n = base, 2
        while (os.path.exists(os.path.join(sessions, sid + ".json"))
               or (store, sid) in _reserved_ids):
            sid, n = f"{base}-{n}", n + 1
        _reserved_ids.add((store, sid))
        return sid


def _safe_emit(emit: Callable[[str, dict], None], kind: str, data: dict) -> None:
    try:
        emit(kind, data)
    except Exception as e:
        log.warning("emit %s failed: %s", kind, e)


def _mcp_entries(entries: Optional[List[str]]) -> List[str]:
    """Session MCP entries: "github" and "mcp:github" both become
    "mcp:github" ("mcp:github/tool" stays), each once."""
    out: List[str] = []
    for e in entries or []:
        e = str(e).strip()
        if not e:
            continue
        e = e if e.startswith("mcp:") else "mcp:" + e
        if e not in out:
            out.append(e)
    return out


def _remap(starts: List[Optional[int]], before: List[Dict[str, Any]],
           after: List[Dict[str, Any]]) -> List[Optional[int]]:
    """Turn starts after a compaction: the same message object's new index,
    or None when that turn's request was summarised away."""
    index = {id(m): i for i, m in enumerate(after)}
    out: List[Optional[int]] = []
    for s in starts:
        if s is None or not 0 <= s < len(before):
            out.append(None)
        else:
            out.append(index.get(id(before[s])))
    return out


@dataclass
class CodeSession:
    id: str
    cwd: str
    project: ProjectInfo
    model: str
    stream_model: str
    backend: str
    mode: str
    context_length: int
    messages: List[Dict[str, Any]]
    todo: TodoList
    rules: RuleStore
    checkpoints: CheckpointStore
    turn_starts: List[Optional[int]] = field(default_factory=list)
    used_tokens: int = 0
    mcp: List[str] = field(default_factory=list)
    knowledge: List[str] = field(default_factory=list)
    turn_ids: List[str] = field(default_factory=list)
    title: str = ""

    def set_options(self, mcp: Optional[bool] = None,
                    knowledge: Optional[List[str]] = None) -> Dict[str, Any]:
        """MCP on/off (every enabled server) and the knowledge bases to search,
        from the next turn. Unknown base names are dropped. None: unchanged."""
        if mcp is not None:
            from aihub import mcp_client
            self.mcp = _mcp_entries(list(mcp_client.enabled_servers())) if mcp else []
        if knowledge is not None:
            from aihub import knowledge as kb
            known = set(kb.names())
            self.knowledge = [n for n in dict.fromkeys(knowledge) if n in known]
        return {"mcp": bool(self.mcp), "knowledge": list(self.knowledge)}

    # -- creating -----------------------------------------------------------

    @classmethod
    def _build(cls, cwd: str, model: str, *, backend: str, mode: str,
               stream_model: Optional[str], context_length: Optional[int],
               mcp: Optional[List[str]], knowledge: Optional[List[str]],
               session_id: Optional[str] = None) -> "CodeSession":
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}; use one of {', '.join(MODES)}")
        if not context_length:
            from aihub import agents
            context_length = agents.agent_context(model, backend)[0]
        project = detect(cwd, context_length)
        set_session_dir(project.root)
        store = store_dir(project.root)
        s = cls(id=session_id or _new_id(store), cwd=os.path.abspath(cwd), project=project,
                model=model, stream_model=stream_model or model, backend=backend, mode=mode,
                context_length=int(context_length), messages=[], todo=TodoList(),
                rules=RuleStore(os.path.join(store, "rules.json")),
                checkpoints=_checkpoints(project.root, store),
                mcp=_mcp_entries(mcp), knowledge=list(knowledge or []))
        # The system message is there from the start, so turn starts recorded
        # before the first turn stay valid once drive_turn refreshes it.
        s.messages.append({"role": "system", "content": s.system_prompt()})
        return s

    @classmethod
    def start(cls, cwd: str, model: str, *, backend: str = "ollama", mode: str = "build",
              stream_model: Optional[str] = None, context_length: Optional[int] = None,
              mcp: Optional[List[str]] = None, knowledge: Optional[List[str]] = None) -> "CodeSession":
        """A new session for the project around `cwd`. MCP servers and
        knowledge bases are opt-in, so small models see only the code tools."""
        return cls._build(cwd, model, backend=backend, mode=mode, stream_model=stream_model,
                          context_length=context_length, mcp=mcp, knowledge=knowledge)

    @classmethod
    def resume(cls, cwd: str, session_id: str) -> "CodeSession":
        """A saved session of the project around `cwd`. FileNotFoundError when
        there is no such session, ValueError when its file is unusable."""
        root, _ = find_root(cwd)
        data = SessionStore(store_dir(root)).load(session_id)
        try:
            messages = data["messages"]
            if not isinstance(messages, list) or not all(isinstance(m, dict) for m in messages):
                raise ValueError("messages")
            mode = data.get("mode") if data.get("mode") in MODES else "build"
            stream_model = data.get("stream_model")
            s = cls._build(cwd, str(data["model"]), backend=str(data.get("backend") or "ollama"),
                           mode=mode, stream_model=str(stream_model) if stream_model else None,
                           context_length=int(data.get("context_length") or 0) or None,
                           mcp=[str(x) for x in data.get("mcp") or []],
                           knowledge=[str(x) for x in data.get("knowledge") or []],
                           session_id=str(data.get("id") or session_id))
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"session {session_id} is unusable: {e}") from e
        if messages and messages[0].get("role") == "system":
            s.messages = messages
        else:
            s.messages = s.messages[:1] + messages
        # Index 0 is the system message; anything else out of range is a
        # turn whose request is gone (undo then appends a note).
        starts = [i if isinstance(i, int) and not isinstance(i, bool) and 1 <= i < len(s.messages)
                  else None for i in data.get("turn_starts") or []]
        ids = [str(t) for t in data.get("turn_ids") or []]
        n = min(len(starts), len(ids))
        s.turn_starts = starts[len(starts) - n:]
        s.turn_ids = ids[len(ids) - n:]
        s.todo.from_list(data.get("todos"))
        used = data.get("used_tokens")
        s.used_tokens = used if isinstance(used, int) and used > 0 else 0
        s.title = str(data.get("title") or "")
        return s

    # -- state ----------------------------------------------------------------

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}; use one of {', '.join(MODES)}")
        self.mode = mode
        store = self.store()
        if os.path.exists(store.path(self.id)):
            store.save(self)

    def system_prompt(self) -> str:
        return build_code_prompt(self.project, self.context_length, self.mode,
                                 self.todo.prompt_block())

    def store(self) -> "SessionStore":
        return SessionStore(store_dir(self.project.root))

    def hooks(self, *, emit: Callable[[str, dict], None], stream_fn: Callable,
              cancel_check: Callable[[], bool]) -> "_Hooks":
        return _Hooks(self, emit=emit, stream_fn=stream_fn, cancel_check=cancel_check)

    def _compactor(self, stream_fn: Callable,
                   cancel_check: Optional[Callable[[], bool]] = None) -> Compactor:
        return Compactor(make_completer(stream_fn, self.stream_model, self.context_length,
                                        cancel_check), cancel_check=cancel_check)

    def compact(self, stream_fn: Callable,
                cancel_check: Optional[Callable[[], bool]] = None) -> CompactionResult:
        """Compact the history now (/compact). A cancel ends the summary
        early with the deterministic fallback."""
        before = list(self.messages)
        result = self._compactor(stream_fn, cancel_check).maybe_compact(
            self.messages, self.context_length, self.used_tokens, force=True)
        assert result is not None  # force=True always compacts or prunes
        self.turn_starts = _remap(self.turn_starts, before, self.messages)
        self.used_tokens = estimate_tokens(self.messages)
        self.store().save(self)
        return result

    # -- undo -------------------------------------------------------------------

    def undo(self, *, confirm: bool, force: bool = False) -> UndoPlan:
        """Undo this session's last turn on disk. With confirm=False only the
        plan comes back. UndoConflict, NothingToUndo and CheckpointError reach
        the caller unchanged, and the history changes only after a successful
        undo."""
        if not self.turn_ids:
            raise NothingToUndo("nothing to undo in this session")
        # The store is shared by the project's sessions: hold its lock so no
        # other session's turn slips in between the check and the undo.
        with self.checkpoints._lock:
            plan = self.checkpoints.undo_plan()
            if plan.turn_id != self.turn_ids[-1]:
                raise CheckpointError(OTHER_SESSION)
            if not confirm:
                return plan
            plan = self.checkpoints.undo(force)
        start = self.turn_starts.pop()
        self.turn_ids.pop()
        if start is None:
            self.messages.append({"role": "user", "content": UNDONE_NOTE})
        else:
            del self.messages[start:]
        # The last Usage measured the undone turn; count what is left.
        self.used_tokens = estimate_tokens(self.messages)
        self.store().save(self)
        return plan


class _Hooks:
    """The `CodeHooks` of one turn of a `CodeSession`."""
    max_tool_rounds = MAX_TOOL_ROUNDS

    def __init__(self, session: CodeSession, *, emit: Callable[[str, dict], None],
                 stream_fn: Callable, cancel_check: Callable[[], bool]):
        from aihub.agents import tool_result_budget
        self.session = session
        self.emit = emit
        self.stream_fn = stream_fn
        self.cancel_check = cancel_check
        self.engine = PermissionEngine(session.project.root, session.rules)
        self.tool_runner = CodeToolRunner(todo=session.todo, checkpoints=session.checkpoints,
                                          emit=emit, cancel_check=cancel_check,
                                          budget=tool_result_budget(session.context_length))
        self._prompt = ""
        self._names: Optional[set] = None

    def tools_schema(self) -> List[Dict[str, Any]]:
        schema = code_tools_schema(self.session.mcp, kb_schema=None)
        self._names = {t["function"]["name"] for t in schema}
        if self.session.knowledge:
            self._names.add("search_knowledge")   # drive_turn adds it
        return schema

    def _offered(self, name: str) -> bool:
        if self._names is None:
            self.tools_schema()
        return name in (self._names or set())

    def system_prompt(self) -> str:
        self._prompt = self.session.system_prompt()
        return self._prompt

    def approve(self, name: str, args: Dict[str, Any],
                ask: Optional[Callable[[Dict[str, Any]], Tuple[bool, Optional[str]]]]) -> "bool | str":
        s = self.session
        if isinstance(name, str) and not self._offered(name):
            # Only this turn's tools: no MCP server the session didn't opt
            # into (any mode), and nothing outside the code tools in plan.
            if "__" in name:
                return MCP_NOT_ENABLED
            if s.mode == "plan":
                return PLAN_DENIAL
        d = self.engine.decide(name, args, s.mode)
        if d.verdict == "allow":
            return True
        if d.verdict == "deny":
            return d.reason if d.reason == PLAN_DENIAL else "Refused: " + d.reason
        if ask is None:
            return NO_APPROVER
        try:
            diff = preview(name, args) if isinstance(args, dict) else None
        except Exception as e:
            log.warning("preview failed: %s", e)
            diff = None
        try:
            answer = ask({
                "name": name, "arguments": args,
                "diff": diff.to_dict() if diff else None,
                "suggested_rule": asdict(d.suggested_rule) if d.suggested_rule else None,
                "mode": s.mode, "reason": d.reason})
            allow, remember, *rest = answer
        except Exception as e:
            log.warning("approval failed: %s", e)
            return False
        if allow is not True:            # only an explicit yes is consent
            said = rest[0].strip() if rest and isinstance(rest[0], str) else ""
            # A denial that says what to do instead: the text becomes the tool
            # result (run_chat_turn treats a str as a denial).
            return DENIED_INSTEAD.format(said) if said else False
        if remember in ("session", "project") and d.suggested_rule:
            try:
                s.rules.add(replace(d.suggested_rule, scope=remember))
            except OSError as e:
                log.warning("could not save the rule: %s", e)
        return True

    def before_round(self, messages: List[Dict[str, Any]], round_index: int) -> None:
        s = self.session
        # Todos may have changed in the last round: refresh the code prompt
        # inside the system message (memory, MCP note and knowledge stay).
        if messages and messages[0].get("role") == "system" and self._prompt:
            content = messages[0].get("content") or ""
            fresh = s.system_prompt()
            if fresh != self._prompt and self._prompt in content:
                messages[0]["content"] = content.replace(self._prompt, fresh, 1)
                self._prompt = fresh
        before = list(messages)
        result = s._compactor(self.stream_fn, self.cancel_check).maybe_compact(
            messages, s.context_length, s.used_tokens)
        if result is not None:
            s.turn_starts = _remap(s.turn_starts, before, messages)
            # The last Usage measured the old history; don't compact again on it.
            s.used_tokens = estimate_tokens(messages)
            _safe_emit(self.emit, "code_compaction", result.to_dict())
        _safe_emit(self.emit, "code_context",
                   {"used": max(s.used_tokens, estimate_tokens(messages)),
                    "limit": s.context_length})

    def on_event(self, ev: object) -> None:
        from .engine.chat import Usage
        if isinstance(ev, Usage):
            self.session.used_tokens = int(ev.prompt_tokens) + int(ev.completion_tokens)

    def finish(self, outcome: TurnOutcome) -> None:
        cp = self.session.checkpoints
        try:
            cp.finish_turn()
        except Exception as e:
            log.warning("could not finish the checkpoint: %s", e)
        turn = self.session.turn_ids[-1] if self.session.turn_ids else ""
        _safe_emit(self.emit, "code_checkpoint", {"turn": turn, "mode": cp.mode, "note": cp.note})


def run_turn(session: CodeSession, text: str, *, emit: Callable[[str, dict], None],
             ask: Optional[Callable[[Dict[str, Any]], Tuple[bool, Optional[str]]]],
             cancel: threading.Event, stream_fn: Callable,
             images: Optional[list] = None) -> TurnOutcome:
    """One user turn of a code session: checkpoint, drive, save."""
    set_session_dir(session.project.root)   # another session may have moved it
    hooks = session.hooks(emit=emit, stream_fn=stream_fn, cancel_check=cancel.is_set)
    turn_id = f"{session.id}-{secrets.token_hex(4)}"
    session.checkpoints.begin_turn(turn_id)
    previous = list(session.turn_starts)
    start = len(session.messages)
    session.turn_starts.append(start)
    session.turn_ids.append(turn_id)
    message: Dict[str, Any] = {"role": "user", "content": text}
    if images:
        message["images"] = list(images)
    session.messages.append(message)
    if not session.title:
        session.title = " ".join(text.split())[:TITLE_CHARS]
    p = {"model": session.model, "stream_model": session.stream_model,
         "backend": session.backend, "messages": session.messages,
         "context_length": session.context_length, "temperature": config.temperature,
         "tools_enabled": True, "knowledge": session.knowledge}
    try:
        outcome = drive_turn(p, emit=emit, ask=ask, cancel=cancel, stream_fn=stream_fn, hooks=hooks)
    except BaseException:
        # The history stays as it was plus the request; any compaction of
        # this turn was on drive_turn's copy, so the old starts still apply.
        session.turn_starts = previous + [start]
        session.store().save(session)
        raise
    # drive_turn hands back a new list with the same message objects in the
    # same order as the list compaction ran on, so turn starts stay valid.
    session.messages = outcome.messages
    session.store().save(session)
    return outcome


class SessionStore:
    """Saved code sessions of one project: `<store>/sessions/<id>.json`."""

    def __init__(self, store: str):
        self.store = store
        self.dir = os.path.join(store, "sessions")

    def path(self, session_id: str) -> str:
        if not isinstance(session_id, str) or not _ID_RE.fullmatch(session_id):
            raise FileNotFoundError(f"no session {session_id!r}")
        return os.path.join(self.dir, session_id + ".json")

    def save(self, session: CodeSession) -> None:
        """Write the session atomically; a failure is logged, never raised."""
        data = {
            "id": session.id, "cwd": session.cwd, "model": session.model,
            "stream_model": session.stream_model, "backend": session.backend,
            "mode": session.mode, "context_length": session.context_length,
            "messages": session.messages, "todos": session.todo.to_list(),
            "turn_starts": session.turn_starts, "turn_ids": session.turn_ids,
            "used_tokens": session.used_tokens, "mcp": session.mcp,
            "knowledge": session.knowledge, "title": session.title,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        tmp = ""
        try:
            path = self.path(session.id)
            os.makedirs(self.dir, exist_ok=True)
            tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
        except (OSError, TypeError, ValueError) as e:
            log.warning("could not save code session %s: %s", session.id, e)
            if tmp:
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    def load(self, session_id: str) -> Dict[str, Any]:
        path = self.path(session_id)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            raise
        except (OSError, ValueError) as e:
            raise ValueError(f"session {session_id} is unreadable: {e}") from e
        if not isinstance(data, dict):
            raise ValueError(f"session {session_id} is unreadable")
        return data

    def list(self) -> List[Dict[str, Any]]:
        """Saved sessions, newest first: id, updated, title, turns."""
        try:
            names = os.listdir(self.dir)
        except OSError:
            return []
        out = []
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                data = self.load(name[:-5])
            except (OSError, ValueError):
                continue
            out.append({"id": str(data.get("id") or name[:-5]),
                        "updated": str(data.get("updated") or ""),
                        "title": _title(data),
                        "turns": len(data.get("turn_starts") or [])})
        out.sort(key=lambda e: (e["updated"], e["id"]), reverse=True)
        return out


def _title(data: Dict[str, Any]) -> str:
    title = data.get("title")
    if isinstance(title, str) and title:
        return title[:TITLE_CHARS]
    for m in data.get("messages") or []:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str) and not content.startswith(SUMMARY_PREFIX):
            return " ".join(content.split())[:TITLE_CHARS]
    return ""
