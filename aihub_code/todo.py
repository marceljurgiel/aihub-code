"""The ``todo_write`` tool: the model's own task list for multi-step work."""
import json

TODO_SCHEMA = {
    "type": "function",
    "function": {
        "name": "todo_write",
        "description": ("Replace your task list. Use it for multi-step work: list the "
                        "steps, mark one in_progress, mark them completed as you go."),
        "parameters": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "status": {"type": "string",
                                       "enum": ["pending", "in_progress", "completed"]},
                        },
                        "required": ["content", "status"],
                    },
                },
            },
            "required": ["todos"],
        },
    },
}

_STATUSES = ("pending", "in_progress", "completed")
MAX_CONTENT = 200
_MARKS = {"completed": "[x]", "in_progress": "[>]", "pending": "[ ]"}


def _clean(item) -> tuple[dict | None, str]:
    """Return (normalised item, "") or (None, reason)."""
    if not isinstance(item, dict):
        return None, "Each todo must be an object with content and status."
    content = item.get("content")
    # One short line each: a newline in an item could fake more items
    # inside the system prompt.
    content = " ".join(content.split())[:MAX_CONTENT] if isinstance(content, str) else ""
    if not content:
        return None, "Each todo needs non-empty content."
    status = item.get("status")
    status = status.strip().lower() if isinstance(status, str) else ""
    if status not in _STATUSES:
        return None, f"Bad status {item.get('status')!r}; use pending, in_progress or completed."
    return {"content": content, "status": status}, ""


class TodoList:
    def __init__(self):
        self.items: list[dict] = []

    def write(self, todos) -> str:
        if isinstance(todos, str):
            try:
                todos = json.loads(todos)
            except ValueError:
                pass
        if not isinstance(todos, list):
            return "[Todo Error] todos must be a list of {content, status} objects."
        clean = []
        for item in todos:
            c, reason = _clean(item)
            if c is None:
                return f"[Todo Error] {reason}"
            clean.append(c)
        doing = sum(1 for c in clean if c["status"] == "in_progress")
        if doing > 1:
            return f"[Todo Error] Only one item can be in_progress (got {doing})."
        self.items = clean
        done = sum(1 for c in clean if c["status"] == "completed")
        return f"Todo list updated: {done}/{len(clean)} completed."

    def prompt_block(self) -> str:
        if not self.items:
            return ""
        return "Current todo:\n" + "\n".join(
            f"{_MARKS[i['status']]} {i['content']}" for i in self.items)

    def to_list(self) -> list[dict]:
        return [dict(i) for i in self.items]

    def from_list(self, items) -> None:
        """Restore saved state; skips invalid entries and never raises."""
        out = []
        if isinstance(items, list):
            for item in items:
                c, _ = _clean(item)
                if c is not None:
                    out.append(c)
        if sum(1 for c in out if c["status"] == "in_progress") > 1:
            seen = False
            for c in out:
                if c["status"] == "in_progress":
                    if seen:
                        c["status"] = "pending"
                    seen = True
        self.items = out
