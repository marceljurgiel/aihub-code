"""
AIHub — Chat engine (event-stream API).

Pure streaming engine that drives one assistant turn (text + N tool rounds).
Consumed by both the CLI subcommand (`aihub chat <model>` via chat_cli.py)
and the Textual TUI (via tui/workers.py).

This module does NOT print, NOT prompt, NOT save automatically. It yields
typed events and mutates the messages list in place. Callers decide how to
render and when to persist.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Union

from aihub.history import save_session
from aihub.memory import build_system_prompt
from aihub.tools import wants_tools, TOOLS_SCHEMA
from .tools import run_tool


def _extract_fallback_tool_calls(text: str, valid_names: set) -> List[Dict[str, Any]]:
    """Recover tool calls the backend failed to parse.

    Imported GGUFs often emit the call as plain text — bare JSON, ```json
    fences, or <tool_call> tags — which Ollama's template-based parser only
    extracts when it matches the template's exact prefix. Accept any JSON
    object with a known tool name + dict arguments/parameters.
    """
    import re as _re

    candidates: List[str] = [
        m.group(1) for m in _re.finditer(
            r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, _re.DOTALL)
    ]
    if not candidates:
        candidates = _re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, _re.DOTALL)
    if not candidates:
        candidates = _bare_call_objects(text)

    calls: List[Dict[str, Any]] = []
    for c in candidates:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        name = obj.get("name")
        args = obj.get("arguments", obj.get("parameters"))
        if isinstance(args, dict):
            name, args = _skill_as_tool(name, args, valid_names)
        if name in valid_names and isinstance(args, dict):
            calls.append({"function": {"name": name, "arguments": args}})
    return calls


_PREAMBLE_MAX = 200   # chars of prose allowed around bare-JSON tool calls


def _bare_call_objects(text: str) -> List[str]:
    """Untagged JSON tool calls: one or more objects, e.g. one per line
    (qwen2.5-coder does this), optionally after a short preamble. A call
    quoted inside a longer answer is prose, not a request, so nothing is
    returned when more than a short preamble surrounds the calls."""
    decoder = json.JSONDecoder()
    found: List[tuple] = []
    i = text.find("{")
    while i != -1:
        try:
            obj, end = decoder.raw_decode(text, i)
        except ValueError:
            i = text.find("{", i + 1)
            continue
        if (isinstance(obj, dict) and isinstance(obj.get("name"), str)
                and isinstance(obj.get("arguments", obj.get("parameters")), dict)):
            found.append((i, end))   # names are checked by the caller
        i = text.find("{", end)
    if not found:
        return []
    rest, last = [], 0
    for start, end in found:
        rest.append(text[last:start])
        last = end
    rest.append(text[last:])
    if len("".join(rest).strip()) > _PREAMBLE_MAX:
        return []
    return [text[s:e] for s, e in found]


def _skill_already_loaded(name: str, args: Dict[str, Any], messages: List[Dict[str, Any]]) -> Optional[str]:
    """use_skill for a skill whose instructions are already in the chat (via
    /skill or an earlier call): don't send them again — small models then
    start the skill over from step 1, in a loop."""
    if name != "use_skill":
        return None
    tag = f'<skill name="{str(args.get("skill", "")).strip().lower()}">'
    for m in messages:
        if m.get("role") in ("user", "tool") and tag in str(m.get("content") or ""):
            return ("[Skill already loaded] Its instructions are earlier in this conversation. "
                    "Don't start over: continue with the next step, using what the user has "
                    "already answered.")
    return None


def _skill_as_tool(name: Any, args: Dict[str, Any], valid_names: set):
    """Small models often call a skill as if it were a tool ("commit" instead
    of use_skill(skill="commit")). Map that to use_skill when it's offered."""
    if name in valid_names or "use_skill" not in valid_names or not isinstance(name, str):
        return name, args
    try:
        from aihub.skills import enabled_skills
        if name.lower() in {s.name for s in enabled_skills()}:
            return "use_skill", {"skill": name.lower()}
    except Exception:
        pass
    return name, args


_FAILURE_TAG = re.compile(r"\[(?:[\w ]+ )?Error\]")   # "[File Error]", "[Tool Error]"…
_TERMINAL_STATUS = re.compile(r"\[(Exit|Error): ([^\]]*)\]")


def tool_failure(result: str) -> Optional[str]:
    """The failure line of a tool result, or None if it succeeded.

    Tools report failure in-band: a tag at the very start ("[File Error] …",
    "[Edit Error] …", "[Tool Error] …"), or for run_terminal a last line of
    "[Exit: N]" / "[Error: …]". Only those positions count, so file contents
    that merely mention "[Edit Error]" don't. Without this the UI showed a
    failed call as a green success.
    """
    text = result.strip()
    if not text:
        return None
    first = text.splitlines()[0]
    if _FAILURE_TAG.match(first):
        return first.strip()
    status = _TERMINAL_STATUS.fullmatch(text.splitlines()[-1].strip())
    if status:
        kind, value = status.groups()
        if kind == "Error":
            return f"Command failed: {value}"
        if value.strip() != "0":
            return f"Command exited with {value.strip()}"
    return None


def _rejects_tools(error: str) -> bool:
    """Does this backend error mean "this model/server can't take tools"?

    Only explicit messages count (Ollama: "... does not support tools";
    llama-server without --jinja: "tools param requires --jinja flag"). A bare
    HTTP 400 is not enough — it is just as often a malformed request or an
    over-long context, and retrying without tools would hide the real error.
    """
    e = error.lower()
    return "does not support tool" in e or "--jinja" in e


def _truncate(text: str, max_chars: int = 8000) -> str:
    """Cap a tool result so large outputs don't blow the context window."""
    if not text or len(text) <= max_chars:
        return text
    head = text[: max_chars // 2]
    tail = text[-max_chars // 2:]
    omitted = len(text) - max_chars
    return f"{head}\n\n... [truncated {omitted} chars] ...\n\n{tail}"


def _normalize_tool_call(tc: Dict[str, Any]) -> Dict[str, Any]:
    """One stored shape for every backend's tool call: an id (backends that
    don't send one get a generated id), type "function", dict arguments.

    The id is what ties the call to its tool result; OpenAI-compatible servers
    (llama.cpp, OpenAI) reject a history where they don't match up.
    """
    fn = tc.get("function", {}) or {}
    raw_args = fn.get("arguments", {})
    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args)
        except Exception:
            args = {}
    else:
        args = raw_args
    if not isinstance(args, dict):
        args = {}
    return {
        "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
        "type": "function",
        "function": {"name": fn.get("name", ""), "arguments": args},
    }


def _tool_message(tc: Dict[str, Any], content: str) -> Dict[str, Any]:
    """Tool-result message linked to its call: `tool_call_id` for
    OpenAI-compatible backends, `tool_name` for Ollama."""
    return {
        "role": "tool",
        "content": content,
        "tool_call_id": tc["id"],
        "tool_name": tc["function"]["name"],
    }


def _cancel_remaining_tools(messages: List[Dict[str, Any]],
                            tool_calls: List[Dict[str, Any]]) -> None:
    """Answer tool calls that will never run, so every assistant tool_calls
    entry keeps a matching tool result in the history."""
    for tc in tool_calls:
        messages.append(_tool_message(
            tc, "[Cancelled by user] This tool call was not executed."))


# ── Event types ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TextChunk:
    """An incremental token slice from the assistant stream."""
    text: str
    round_index: int


@dataclass(frozen=True)
class ThinkingChunk:
    """An incremental slice of the model's reasoning (Ollama `message.thinking`,
    OpenAI-compatible `reasoning_content`). Shown live, never added to the
    history — the model doesn't need its own old reasoning back."""
    text: str
    round_index: int


@dataclass(frozen=True)
class ToolCallRequested:
    """The model has asked us to invoke a tool; about to execute."""
    call_id: str
    name: str
    arguments: Dict[str, Any]
    round_index: int


@dataclass(frozen=True)
class ToolCallResult:
    """A tool finished. The result has already been appended to messages as a
    'tool' role entry by the engine."""
    call_id: str
    name: str
    arguments: Dict[str, Any]
    result: str
    duration_ms: int
    round_index: int
    error: Optional[str] = None
    # The user declined the call in the approval prompt (error is also set).
    denied: bool = False


@dataclass(frozen=True)
class RoundCompleted:
    """One stream finished. If had_tool_calls another round will follow."""
    round_index: int
    assistant_text: str
    had_tool_calls: bool


@dataclass(frozen=True)
class Done:
    """The turn is complete; no further events will follow.

    cancelled=True → the caller's cancel_check fired. `messages` is still
    consistent: partial assistant text is kept, and any tool call that never
    ran gets a "[Cancelled by user]" tool result.
    """
    final_text: str
    cancelled: bool = False


@dataclass(frozen=True)
class Usage:
    """Token usage for one model call (round). prompt_tokens is the context the
    model read this round; completion_tokens is what it generated; tps is the
    generation speed (tokens/second)."""
    prompt_tokens: int
    completion_tokens: int
    round_index: int
    tps: float = 0.0


@dataclass(frozen=True)
class Error:
    """A streaming or tool error.

    fatal=True   → engine stops; no Done will follow.
    fatal=False  → informational; the engine recovers (e.g. retried without
                   tools when the model rejects the tools field).
    """
    message: str
    fatal: bool = True
    retry_without_tools: bool = False


ChatEvent = Union[TextChunk, ThinkingChunk, ToolCallRequested, ToolCallResult,
                  RoundCompleted, Usage, Done, Error]


# ── Session setup / teardown ──────────────────────────────────────────────────

def start_session(
    model_name: str,
    initial_messages: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Build (or rebuild) the messages list with a fresh system prompt drawn from
    current memory. If `initial_messages` already contains a system message it
    is replaced — resumed sessions always pick up the current memory state.

    Also strips `tool_calls` from any assistant messages so that a freshly
    downloaded model that doesn't support tools doesn't get a 400 on the
    first turn.
    """
    messages: List[Dict[str, Any]] = []
    for m in (initial_messages or []):
        clean = {k: v for k, v in m.items() if k != "tool_calls"}
        messages.append(clean)

    sys_prompt = build_system_prompt()
    if sys_prompt:
        if messages and messages[0].get("role") == "system":
            messages[0]["content"] = sys_prompt
        else:
            messages.insert(0, {"role": "system", "content": sys_prompt})
    return messages


def finalize_session(
    model_name: str,
    messages: List[Dict[str, Any]],
    temperature: float,
    start_time: datetime,
    backend: str = "ollama",
    stream_model: str = "",
) -> Optional[str]:
    """Persist the session if any user message exists. Returns saved path or None."""
    if any(m.get("role") == "user" for m in messages):
        path = save_session(
            model_name, messages, temperature, start_time,
            backend=backend, stream_model=stream_model,
        )
        return path or None
    return None


# ── Chat turn engine ──────────────────────────────────────────────────────────

def run_chat_turn(
    model_name: str,
    messages: List[Dict[str, Any]],
    *,
    temperature: float = 0.7,
    context_length: Optional[int] = None,
    tools_enabled: bool = True,
    max_tool_rounds: int = 25,
    stream_fn=None,
    approve_fn=None,
    tools_schema=None,
    cancel_check: Optional[Callable[[], bool]] = None,
    tool_runner: Optional[Callable[[str, Dict[str, Any]], str]] = None,
    before_round: Optional[Callable[[List[Dict[str, Any]], int], None]] = None,
    round_limit_fatal: bool = True,
) -> Iterator[ChatEvent]:
    """
    Drive one assistant turn — initial text plus any subsequent tool rounds —
    for an already-appended user message. Mutates `messages` in place,
    appending assistant text and tool results as rounds complete.

    Always terminates with either Done or a fatal Error event.

    stream_fn: callable matching ollama_client.chat_stream signature.
    Defaults to ollama_client.chat_stream when None.

    approve_fn: optional callable(tool_name, args) -> bool, consulted before
    executing each tool. Returning False denies the call (the model is told).
    Used by agent Plan mode for interactive approval. Default = allow all.

    tools_schema: optional explicit tool schema. When provided (agent mode), the
    full set is always offered (the chat `wants_tools` intent gate is skipped).

    cancel_check: optional callable() -> bool, polled between stream chunks and
    before each tool runs. When it returns True the backend stream is closed
    (which drops the HTTP connection, so the server stops generating), no
    further tools run, and the turn ends with Done(cancelled=True).

    tool_runner: optional callable(name, args) -> str that runs a tool instead
    of `run_tool` (its result is still truncated to the tool-result budget).

    before_round: optional callable(messages, round_index), run at the top of
    each round after the cancel check (a code harness trims/compacts there).

    approve_fn may also return a str: that is a denial, and the text becomes
    the tool result (instead of the "[Denied by user]" text).

    round_limit_fatal: when False, hitting `max_tool_rounds` ends the turn with
    a Done that says so, instead of a fatal Error.
    """
    def _cancelled() -> bool:
        return cancel_check is not None and bool(cancel_check())

    # Resolve backend lazily — only imports ollama_client when needed
    if stream_fn is None:
        from aihub.ollama_client import chat_stream as _sf
    else:
        _sf = stream_fn

    from aihub.tools import without_unused
    active_schema = without_unused(tools_schema if tools_schema is not None else TOOLS_SCHEMA)
    if tools_schema is not None:
        # Agent mode: tools are always available (no intent gate).
        tools_active = tools_enabled
    else:
        # Chat: only offer tools when the latest user message shows tool intent.
        tools_active = tools_enabled and wants_tools(messages)
    final_text = ""
    # `remember` checks facts against what the user actually said.
    from aihub.tools import set_user_text
    from aihub.memory_learn import strip_quoted
    user_said = " ".join(strip_quoted(str(m.get("content") or ""))
                         for m in messages if m.get("role") == "user")
    nudged = False
    nudge = None
    # A tool result may take a fair share of the context, not all of it.
    from aihub.agents import tool_result_budget
    tool_result_chars = tool_result_budget(context_length)

    for round_index in range(max_tool_rounds):
        if _cancelled():
            yield Done(final_text=final_text, cancelled=True)
            return
        if before_round is not None:
            before_round(messages, round_index)
            # A compaction there may have run long; the user may have
            # cancelled meanwhile.
            if _cancelled():
                yield Done(final_text=final_text, cancelled=True)
                return

        full_text = ""
        pending_tool_calls: List[Dict[str, Any]] = []

        prompt_tokens = 0
        completion_tokens = 0
        eval_duration_ns = 0
        round_t0 = time.time()

        # One round may need to retry once if the model rejects the tools field.
        for attempt in (1, 2):
            full_text = ""
            pending_tool_calls = []
            prompt_tokens = 0
            completion_tokens = 0
            eval_duration_ns = 0
            round_t0 = time.time()
            stream_kwargs: Dict[str, Any] = {}
            if tools_active:
                stream_kwargs["tools"] = active_schema

            retry = False
            stream = None
            try:
                stream = _sf(
                    model_name, messages, temperature,
                    context_length=context_length, **stream_kwargs,
                )
                for chunk in stream:
                    if _cancelled():
                        break
                    if "error" in chunk:
                        err_msg = str(chunk["error"])
                        _tool_unsupported = _rejects_tools(err_msg)
                        if _tool_unsupported and tools_active:
                            tools_active = False
                            retry = True
                            yield Error(
                                message="Model does not support tools — retrying without.",
                                fatal=False,
                                retry_without_tools=True,
                            )
                            break
                        # Ollama Cloud plan/retired/limit errors in plain words.
                        from aihub.ollama_cloud import explain, is_cloud, record_error
                        if is_cloud(model_name):
                            record_error(model_name, err_msg)
                        yield Error(message=explain(err_msg, model_name) or f"API error: {err_msg}", fatal=True)
                        return

                    msg = chunk.get("message", {}) or {}
                    thought = msg.get("thinking")
                    if thought:
                        yield ThinkingChunk(text=thought, round_index=round_index)
                    piece = msg.get("content", "")
                    if piece:
                        full_text += piece
                        yield TextChunk(text=piece, round_index=round_index)
                    for tc in msg.get("tool_calls", []) or []:
                        pending_tool_calls.append(tc)
                    # Token usage — Ollama (top-level eval counts) or API ("usage").
                    if "prompt_eval_count" in chunk or "eval_count" in chunk:
                        prompt_tokens = chunk.get("prompt_eval_count") or prompt_tokens
                        completion_tokens = chunk.get("eval_count") or completion_tokens
                    if chunk.get("eval_duration"):
                        eval_duration_ns = chunk["eval_duration"]
                    usage = chunk.get("usage")
                    if usage:
                        prompt_tokens = usage.get("prompt_tokens") or prompt_tokens
                        completion_tokens = usage.get("completion_tokens") or completion_tokens
            except Exception as exc:
                _tool_exc = _rejects_tools(str(exc))
                if _tool_exc and tools_active:
                    tools_active = False
                    retry = True
                    yield Error(
                        message="Model does not support tools — retrying without.",
                        fatal=False,
                        retry_without_tools=True,
                    )
                else:
                    yield Error(message=f"Unexpected error: {exc}", fatal=True)
                    return
            finally:
                # Closing the backend generator closes its HTTP response, so
                # the server stops generating when we stop reading early.
                close = getattr(stream, "close", None)
                if close is not None:
                    close()

            if not retry:
                break

        # The one-off "answer now" nudge was for that request only.
        if nudge is not None and nudge in messages:
            messages.remove(nudge)

        if _cancelled():
            # Keep what the user already saw; drop half-received tool calls.
            if full_text:
                messages.append({"role": "assistant", "content": full_text})
                final_text = full_text
            yield Done(final_text=final_text, cancelled=True)
            return

        # Report this round's token usage + generation speed. Prefer Ollama's
        # precise eval_duration; otherwise fall back to wall-clock.
        if prompt_tokens or completion_tokens:
            if eval_duration_ns > 0:
                tps = completion_tokens / (eval_duration_ns / 1e9)
            else:
                elapsed = max(time.time() - round_t0, 1e-6)
                tps = completion_tokens / elapsed
            yield Usage(
                prompt_tokens=int(prompt_tokens),
                completion_tokens=int(completion_tokens),
                round_index=round_index,
                tps=round(tps, 1),
            )

        # Backend didn't parse a tool call — but the model may have emitted
        # one as plain text (common with imported GGUFs whose output doesn't
        # match the template's exact tool prefix). Recover it client-side.
        if tools_active and not pending_tool_calls and full_text:
            valid_names = {t.get("function", {}).get("name")
                           for t in (active_schema or [])}
            fallback = _extract_fallback_tool_calls(full_text, valid_names)
            if fallback:
                pending_tool_calls = fallback
                full_text = ""

        # ── Tools ran but the model then said nothing (small models stop
        #    after a failed tool): ask once more for the actual answer. ──
        if (not pending_tool_calls and not full_text.strip() and round_index > 0
                and not nudged and not _cancelled()):
            nudged = True
            nudge = {"role": "system", "content": (
                "You haven't answered the user yet. Using the tool results above, "
                "answer now — or call another tool if you still need one. If a tool "
                "failed, say what failed.")}
            messages.append(nudge)
            continue

        # ── No tool calls → final text, end turn ──────────────────────────
        if not pending_tool_calls:
            messages.append({"role": "assistant", "content": full_text})
            final_text = full_text
            yield RoundCompleted(
                round_index=round_index,
                assistant_text=full_text,
                had_tool_calls=False,
            )
            yield Done(final_text=final_text)
            return

        # ── Append assistant message carrying tool_calls metadata ─────────
        pending_tool_calls = [_normalize_tool_call(tc) for tc in pending_tool_calls]
        valid = {t.get("function", {}).get("name") for t in (active_schema or [])}
        for tc in pending_tool_calls:
            fn = tc["function"]
            fn["name"], fn["arguments"] = _skill_as_tool(fn["name"], fn["arguments"], valid)
        messages.append({
            "role": "assistant",
            "content": full_text,
            "tool_calls": pending_tool_calls,
        })
        final_text = full_text
        yield RoundCompleted(
            round_index=round_index,
            assistant_text=full_text,
            had_tool_calls=True,
        )

        # ── Execute each tool; append result and emit events ──────────────
        for i, tc in enumerate(pending_tool_calls):
            if _cancelled():
                _cancel_remaining_tools(messages, pending_tool_calls[i:])
                yield Done(final_text=final_text, cancelled=True)
                return
            name = tc["function"]["name"]
            args = tc["function"]["arguments"]
            call_id = tc["id"]

            yield ToolCallRequested(
                call_id=call_id, name=name, arguments=args,
                round_index=round_index,
            )

            t0 = time.monotonic()
            approved = True if approve_fn is None else approve_fn(name, args)
            # The user may have cancelled while an approval prompt was open.
            if _cancelled():
                _cancel_remaining_tools(messages, pending_tool_calls[i:])
                yield Done(final_text=final_text, cancelled=True)
                return
            denied = isinstance(approved, str) or not approved
            if denied and isinstance(approved, str):
                result_text = approved
                error = "Denied"
            elif denied:
                result_text = (
                    f"[Denied by user] The user declined this {name} call, so it "
                    "was NOT run and nothing changed. Tell the user it wasn't "
                    "done because they declined it; don't retry unless they ask.")
                error = "Denied by user"
            else:
                try:
                    set_user_text(user_said)
                    try:
                        result_text = (_skill_already_loaded(name, args, messages)
                                       or _truncate(tool_runner(name, args) if tool_runner is not None
                                                    else run_tool(name, **args), tool_result_chars))
                    finally:
                        set_user_text(None)
                    error = tool_failure(result_text)
                except Exception as exc:
                    result_text = f"[Tool Error] {exc}"
                    error = str(exc)
            duration_ms = int((time.monotonic() - t0) * 1000)

            messages.append(_tool_message(tc, result_text))

            yield ToolCallResult(
                call_id=call_id, name=name, arguments=args,
                result=result_text, duration_ms=duration_ms,
                round_index=round_index, error=error, denied=denied,
            )

        # Loop: let the model respond again with the tool output in context.

    # Exceeded max rounds.
    if not round_limit_fatal:
        yield Done(final_text=final_text
                   + f"\n\n[Stopped after {max_tool_rounds} tool rounds — ask me to continue.]",
                   cancelled=False)
        return
    yield Error(
        message=f"Tool-call loop limit reached ({max_tool_rounds} rounds).",
        fatal=True,
    )
