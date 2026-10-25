"""Permission decisions for the coding harness: allow, ask or deny a tool call.

This is a security boundary: whenever a rule or command is doubtful the answer
is "ask", never "allow".
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import re
from dataclasses import dataclass
from typing import Optional

from .engine.filelock import file_lock
from aihub.mcp_client import needs_approval, split_name
from aihub.tools.terminal import _DANGEROUS_PREFIXES
from aihub.tools.workdir import resolve
from .paths import in_git_dir, inside_root

log = logging.getLogger(__name__)

MODES = ("plan", "build", "auto")

PLAN_DENIAL = (
    "Plan mode: this call was refused because plan mode is read-only. "
    "Present your plan instead; the user switches to build mode to apply it."
)

_ALWAYS_ALLOWED = {"read_file", "list_files", "search_files", "todo_write", "search_knowledge"}
_MUTATING = {"write_file", "edit_file", "run_terminal"}


@dataclass(frozen=True)
class Rule:
    tool: str
    pattern: Optional[str] = None
    scope: str = "session"


@dataclass
class Decision:
    verdict: str  # "allow" | "ask" | "deny"
    reason: str = ""
    suggested_rule: Optional[Rule] = None


class RuleStore:
    """Always-allow rules: `session` ones live in memory, `project` ones in a
    JSON file next to the project's other harness state."""

    def __init__(self, path: str):
        self.path = path
        self.session: list[Rule] = []

    def project(self) -> list[Rule]:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            out = []
            for r in data["rules"]:
                pattern = r.get("pattern")
                if not isinstance(r["tool"], str) or not (pattern is None or isinstance(pattern, str)):
                    raise ValueError("bad rule")
                out.append(Rule(r["tool"], pattern, "project"))
            return out
        except FileNotFoundError:
            return []
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            log.warning("ignoring unreadable rules file %s: %s", self.path, e)
            return []

    def _write(self, rules: list[Rule]) -> None:
        d = os.path.dirname(self.path) or "."
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, os.path.basename(self.path) + f".{os.getpid()}.tmp")
        payload = {"version": 1, "rules": [{"tool": r.tool, "pattern": r.pattern} for r in rules]}
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, self.path)

    def add(self, rule: Rule) -> None:
        if rule.scope == "project":
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with file_lock(self.path + ".lock"):
                rules = self.project()
                if not any((r.tool, r.pattern) == (rule.tool, rule.pattern) for r in rules):
                    rules.append(rule)
                    self._write(rules)
        elif rule not in self.session:
            self.session.append(rule)

    def remove(self, rule: Rule) -> None:
        if rule.scope == "project":
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with file_lock(self.path + ".lock"):
                rules = [r for r in self.project() if (r.tool, r.pattern) != (rule.tool, rule.pattern)]
                self._write(rules)
        else:
            self.session = [r for r in self.session if r != rule]

    def all(self) -> list[Rule]:
        return list(self.session) + self.project()


_SPLIT_RE = re.compile(r"&&|\|\||;|\||\n")


def split_command(cmd: str, windows: bool) -> Optional[list[str]]:
    """Split a shell command into simple segments, or None when it uses
    constructs (substitution, redirection, ...) that rules cannot judge."""
    bad = ("$(", "`", ">", "<", "(", ")")
    if windows:
        bad += ("&", "|", ";", "\n", "\r", "{", "}", "@", "$")
    if any(b in cmd for b in bad):
        return None
    if "&" in cmd.replace("&&", ""):  # lone & (background) or |&
        return None
    return [s.strip() for s in _SPLIT_RE.split(cmd) if s.strip()]


def _tokens(s: str, windows: bool) -> list[str]:
    try:
        return shlex.split(s, posix=not windows)
    except ValueError:
        return s.split()


def rule_matches(rule: Rule, name: str, args: dict, windows: bool) -> bool:
    if rule.tool != name:
        return False
    if name != "run_terminal":
        return rule.pattern is None
    cmd = args.get("command")
    if not isinstance(cmd, str) or not rule.pattern or not rule.pattern.strip():
        return False
    segments = split_command(cmd, windows)
    if not segments:
        return False
    if _runs_executor(segments, windows):
        # find/sed/tar/... decide in their arguments what they run or
        # write: only an exact-command rule covers them (R33).
        return cmd.strip() == rule.pattern.strip()
    if windows:
        c, p = cmd.strip(), rule.pattern.strip()
        return c == p or c.startswith(p + " ")
    ptoks = _tokens(rule.pattern, windows)
    if not ptoks:
        return False
    for seg in segments:
        stoks = _tokens(seg, windows)
        if stoks[: len(ptoks)] != ptoks:
            return False
    return True


_DANGEROUS_CMDS = {
    "rm", "rmdir", "dd", "shred", "fdisk", "parted", "truncate", "remove-item", "ri",
    "del", "erase", "rd", "format-volume", "clear-disk", "iex", "invoke-expression",
}
_SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "iex", "invoke-expression"}
_PIPE_TO_SHELL = re.compile(r"\|\s*(sudo\s+)?(sh|bash|zsh|dash|pwsh|powershell|iex)\b", re.I)
# Words that only run what follows them: the real command is the next word.
_SKIP_WORDS = {
    "then", "do", "else", "elif", "if", "while", "until", "!", "command", "exec", "sudo",
    "doas", "env", "nohup", "time", "xargs", "nice",
}
_RUNNERS = {
    "py", "cmd", "pwsh", "powershell", "bash", "sh", "zsh", "fish", "deno", "env", "sudo", "doas",
    "xargs", "nohup", "time", "exec", "eval", "npx", "bunx", "uvx", "pipx",
}
_RUNNER_RE = re.compile(r"^(python|node|ruby|perl|php)[0-9.]*$")
_RISKY_GIT = {"push", "reset", "clean", "checkout", "rebase"}
_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_OVER_SPLIT = re.compile(r"(&&|\|\||\$\(|[;|&\n\r(){}`])")


def _clean(token: str) -> str:
    """Drop shell quoting and glob characters, so `$'rm'`, `r[m]` and "rm" read rm."""
    return re.sub(r"[\'\"$\[\]*?]", "", token)


def _command_word(tokens: list[str]) -> tuple[str, int]:
    """(lower-cased basename of the real command word, its index). Leading
    NAME=value assignments, keywords (then, do, ...) and wrappers (sudo, env,
    ...) with their options are skipped. ("", len) when nothing is left."""
    i, wrapped = 0, False
    while i < len(tokens):
        t = tokens[i]
        word = _clean(re.split(r"[\\/]", t)[-1]).lower()
        if _ASSIGN_RE.match(t):
            i += 1
        elif word in _SKIP_WORDS:
            wrapped = True
            i += 1
        elif wrapped and t.startswith("-"):
            i += 1
        else:
            return (word[:-4] if word.endswith(".exe") else word), i
    return "", len(tokens)


def _first_word(tokens: list[str]) -> str:
    return _command_word(tokens)[0]


# Programs that run other programs or write files given in their arguments:
# a prefix rule for them would allow anything (`find -exec`, `sed -i`, ...).
_EXECUTORS = {
    "find", "sed", "gsed", "awk", "gawk", "mawk", "nawk", "tar", "gtar", "bsdtar", "rsync",
    "ssh", "scp", "sftp", "xargs", "parallel", "watch", "timeout", "nice", "nohup", "ionice",
    "setsid", "stdbuf", "flock", "chroot", "strace", "busybox",
}
_FIND_RISKY = {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"}
_TAR_RISKY_LONG = ("--extract", "--get", "--directory", "--to-command", "--checkpoint-action",
                   "--use-compress-program", "--info-script", "--new-volume-script",
                   "--rsh-command", "--rmt-command")
_TAR_RISKY_SHORT = set("xCFI")


def _runs_executor(segments: list[str], windows: bool) -> bool:
    """True when a segment runs an executor program (also behind sudo/env,
    or as a wrapper itself), or git with global options (`git -c …`)."""
    for seg in segments:
        toks = _tokens(seg, windows)
        if not toks:
            continue
        first = _clean(re.split(r"[\\/]", toks[0])[-1]).lower()
        word, idx = _command_word(toks)
        if first.endswith(".exe"):
            first = first[:-4]
        if first in _EXECUTORS or word in _EXECUTORS:
            return True
        if word == "git" and idx + 1 < len(toks) and toks[idx + 1].startswith("-"):
            return True
    return False


def _abbrev(name: str, full: str) -> bool:
    """`name` is `full` or a GNU abbreviation of it (at least --x)."""
    return len(name) >= 3 and full.startswith(name)


def _expands(token: str) -> bool:
    return "$" in token or "`" in token


def _skip_to(script: str, i: int, stops: str) -> int:
    while i < len(script) and script[i] not in stops:
        i += 1
    return i


def _skip_delimited(script: str, i: int, delim: str) -> int:
    """Index just past the next unescaped `delim` at or after `i`, or -1."""
    while i < len(script):
        c = script[i]
        if c == "\\":
            i += 2
            continue
        if c == "\n" or c == delim:
            return i + 1 if c == delim else -1
        i += 1
    return -1


def _sed_script_risky(script: str) -> bool:
    """True when a sed script runs commands or writes files: the `e`, `w`
    and `W` commands, or an `s` command with the e or w flag. Anything it
    can't parse counts as risky."""
    i, n = 0, len(script)
    while i < n:
        c = script[i]
        if c in " \t\n;{}!":
            i += 1
            continue
        # Addresses: line numbers, $, ranges, steps, /regex/ and \cregexc.
        if c.isdigit() or c in "$,~+":
            i += 1
            continue
        if c == "/" or c == "\\":
            if c == "\\":
                if i + 1 >= n:
                    return True
                delim, i = script[i + 1], i + 2
            else:
                delim, i = "/", i + 1
            i = _skip_delimited(script, i, delim)
            if i < 0:
                return True
            while i < n and script[i] in "IM":
                i += 1
            continue
        if c in "ewW":
            return True
        if c in "sy":
            if i + 1 >= n or script[i + 1] in "\\\n":
                return True
            delim, i = script[i + 1], i + 2
            for _ in range(2):
                i = _skip_delimited(script, i, delim)
                if i < 0:
                    return True
            end = _skip_to(script, i, ";\n}")
            if c == "s" and any(f in script[i:end] for f in "ew"):
                return True
            i = end
            continue
        if c in "btTv:":
            # A label (or v's version): it ends at whitespace or `;`.
            i += 1
            while i < n and script[i] in " \t":
                i += 1
            i = _skip_to(script, i, " \t\n;")
            continue
        if c in "aicrR#":
            # Text, a file name or a comment up to the end of the line (r/R
            # read a file; they never write one).
            i = _skip_to(script, i + 1, "\n")
            continue
        i += 1
    return False


def _sed_risky(args: list[str], read_scripts: bool = True) -> bool:
    scripts, has_e, k = [], False, 0
    while k < len(args):
        t = args[k]
        if t == "--":
            # End of options: the first operand after it may be the script.
            if not has_e and not scripts and k + 1 < len(args):
                scripts.append(args[k + 1])
            break
        if t.startswith("-") and _expands(t):
            return True             # an option the shell builds at run time
        if t.startswith("--"):
            name, eq, value = t.partition("=")
            if _abbrev(name, "--in-place") or _abbrev(name, "--file"):
                return True
            if _abbrev(name, "--line-length"):
                k += 1 if eq else 2
                continue
            if _abbrev(name, "--expression"):
                has_e = True
                if eq:
                    scripts.append(value)
                elif k + 1 < len(args):
                    scripts.append(args[k + 1])
                    k += 1
                else:
                    return True
        elif t.startswith("-") and len(t) > 1:
            flags = t[1:]
            if "i" in flags or "f" in flags:
                return True
            if "e" in flags:
                has_e = True
                rest = flags[flags.index("e") + 1:]
                if rest:
                    scripts.append(rest)
                elif k + 1 < len(args):
                    scripts.append(args[k + 1])
                    k += 1
                else:
                    return True
            elif flags.endswith("l") and k + 1 < len(args):
                k += 1          # -l N: the line length
        elif not has_e and not scripts:
            scripts.append(t)   # the first operand is the script
        k += 1
    return read_scripts and any(_sed_script_risky(s) for s in scripts)


def _tar_risky(args: list[str]) -> bool:
    for k, t in enumerate(args):
        if t.startswith("-") and _expands(t):
            return True
        if t.startswith("--"):
            name = t.split("=", 1)[0]
            if name.startswith(_TAR_RISKY_LONG) or (
                    len(name) >= 5 and any(r.startswith(name) for r in _TAR_RISKY_LONG)):
                return True
        elif t.startswith("-") or (k == 0 and t.isalpha()):
            # -xzf, or the old style `tar xf a.tar` (a bundle without dash).
            if _TAR_RISKY_SHORT & set(t.lstrip("-")):
                return True
    return False


def _find_risky(args: list[str]) -> bool:
    if any(_expands(a) for a in args):
        return True                 # `-ex$@ec`: the shell builds the option
    low = [_clean(a).lower() for a in args]
    return any(a in _FIND_RISKY or a.startswith("-fprint") for a in low)


def _executor_risky(tokens: list[str], read_scripts: bool = True) -> bool:
    """find/sed/tar anywhere in one command (also behind wrappers such as
    `timeout 5 find …`) with arguments that run programs or write files.
    `read_scripts=False`: the tokens came from broken quoting, so sed
    scripts are judged by the quote-aware pass only."""
    for j, t in enumerate(tokens):
        word = _clean(re.split(r"[\\/]", t)[-1]).lower()
        if word.endswith(".exe"):
            word = word[:-4]
        rest = tokens[j + 1:]
        if word == "find" and _find_risky(rest):
            return True
        if word in ("sed", "gsed") and _sed_risky(rest, read_scripts):
            return True
        if word in ("tar", "gtar", "bsdtar") and _tar_risky(
                [a if _expands(a) else _clean(a) for a in rest]):
            return True
    return False


def _shell_segments(cmd: str, windows: bool) -> list[list[str]]:
    """Simple commands of `cmd`, split on unquoted separators (quote-aware,
    unlike the over-splitting pass). [] when the quoting is unbalanced."""
    try:
        lex = shlex.shlex(cmd, posix=not windows, punctuation_chars=True)
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:
        return []
    segs: list[list[str]] = [[]]
    for t in toks:
        if t and all(c in "();<>|&" for c in t):
            segs.append([])
        else:
            segs[-1].append(t)
    return [s for s in segs if s]


def is_dangerous(cmd: str, windows: bool) -> bool:
    """Destructive-looking command anywhere in `cmd`. Over-splits on every
    shell separator and looks at each segment's real command word; false
    positives only mean more asking."""
    lower = cmd.lower()
    if any(p in lower for p in _DANGEROUS_PREFIXES) or _PIPE_TO_SHELL.search(cmd):
        return True
    # Quoted sed scripts may hold `;` and newlines: judge those whole.
    if any(_executor_risky(seg) for seg in _shell_segments(cmd, windows)):
        return True
    parts = _OVER_SPLIT.split(cmd)
    after_pipe = False
    for k in range(0, len(parts), 2):
        seg = parts[k]
        sep_before = parts[k - 1] if k else ""
        if sep_before:
            after_pipe = sep_before == "|" or (after_pipe and sep_before == "&" and not parts[k - 2].strip())
        if not seg.strip():
            continue
        try:
            toks, balanced = shlex.split(seg, posix=not windows), True
        except ValueError:
            toks, balanced = seg.split(), False
        word, idx = _command_word(toks)
        flat = [_clean(t).lower() for t in toks]
        if word in _DANGEROUS_CMDS or word.startswith("mkfs"):
            return True
        if after_pipe and word in _SHELLS:
            return True
        if word == "find" and "-delete" in flat:
            return True
        if _executor_risky(toks, balanced):
            return True
        if word == "git" and "clean" in flat[idx + 1:]:
            return True
        after_pipe = False
    return False


def _git_exact(toks: list[str]) -> bool:
    """True when a git command has global options or a risky subcommand."""
    if len(toks) < 2:
        return False
    if toks[1].startswith("-"):
        return True  # global option before the subcommand
    return toks[1] in _RISKY_GIT


_BARE_PROGRAM = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.+-]*$")


def suggest_rule(name: str, args: dict, windows: bool = os.name == "nt") -> Rule:
    """Rule offered after an approval. A prefix rule only for a bare program
    name (no path, quote, `=`, `$`, glob) that is not a runner or wrapper;
    everything else gets the exact command."""
    if name != "run_terminal":
        return Rule(name)
    cmd = args.get("command")
    if not isinstance(cmd, str) or not cmd.split():
        return Rule(name)
    exact = Rule(name, cmd.strip())
    words = cmd.split()
    first = words[0]
    if not _BARE_PROGRAM.match(first):
        return exact
    low = first.lower()
    if low.endswith(".exe"):
        low = low[:-4]
    if low in _RUNNERS or low in _SKIP_WORDS or low in _EXECUTORS or _RUNNER_RE.match(low):
        return exact
    toks = [_clean(t) for t in _tokens(cmd, windows)] or words
    if low == "git" and _git_exact(toks):
        return exact
    if low == "bun" and len(toks) > 1 and toks[1] == "x":
        return exact
    pattern = first
    if len(words) > 1 and not words[1].startswith("-") and not any(c in words[1] for c in "/\\."):
        pattern += " " + words[1]
    return Rule(name, pattern)


class PermissionEngine:
    def __init__(self, root: str, rules: RuleStore, windows: bool = os.name == "nt"):
        self.root = root
        self.rules = rules
        self.windows = windows

    def _allowed_by_rule(self, name: str, args: dict, rules: list[Rule]) -> bool:
        return any(rule_matches(r, name, args, self.windows) for r in rules)

    def decide(self, name: str, args: dict, mode: str) -> Decision:
        if not isinstance(name, str):
            return Decision("ask", "unknown tool")
        args = args if isinstance(args, dict) else {}
        plan = mode == "plan"

        if name in ("write_file", "edit_file"):
            reason = ""
            try:
                target = resolve(str(args["path"]))
                if not inside_root(target, self.root):
                    reason = "outside the project"
                elif in_git_dir(target, self.root):
                    reason = "inside .git"
            except (KeyError, TypeError, ValueError, OSError):
                reason = "outside the project"
            if reason:
                if plan:
                    return Decision("deny", PLAN_DENIAL)
                return Decision("deny" if mode == "auto" else "ask", reason)

        if name in _ALWAYS_ALLOWED:
            return Decision("allow")

        if "__" in name:
            if needs_approval(name) or split_name(name) is None:
                return Decision("deny", PLAN_DENIAL) if plan else Decision("ask", "MCP tool needs approval")
            return Decision("allow")

        if name in _MUTATING:
            if plan:
                return Decision("deny", PLAN_DENIAL)
            rules = self.rules.all()
            if name == "run_terminal":
                cmd = args.get("command")
                if not isinstance(cmd, str) or not cmd.strip():
                    return Decision("ask", "empty command")
                if is_dangerous(cmd, self.windows):
                    exact = split_command(cmd, self.windows) is not None and any(
                        r.tool == name and r.pattern == cmd.strip() for r in rules
                    )
                    if mode == "build" and exact:
                        return Decision("allow")
                    return Decision("ask", "destructive command", Rule(name, cmd.strip()) if mode == "build" else None)
            if mode == "auto":
                return Decision("allow")
            if mode == "build":
                if self._allowed_by_rule(name, args, rules):
                    return Decision("allow")
                return Decision("ask", "needs approval", suggest_rule(name, args, self.windows))
            return Decision("ask", "unknown mode")

        return Decision("ask", "unknown tool")
