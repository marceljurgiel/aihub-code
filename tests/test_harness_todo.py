from aihub_code.todo import TODO_SCHEMA, TodoList


def _t(content, status="pending"):
    return {"content": content, "status": status}


def test_schema_shape():
    fn = TODO_SCHEMA["function"]
    assert fn["name"] == "todo_write"
    assert fn["parameters"]["required"] == ["todos"]


def test_write_replaces_list():
    tl = TodoList()
    assert tl.write([_t("a", "completed"), _t("b", "in_progress"), _t("c")]) == \
        "Todo list updated: 1/3 completed."
    assert tl.write([_t("x")]) == "Todo list updated: 0/1 completed."
    assert tl.items == [_t("x")]


def test_two_in_progress_rejected_keeps_old():
    tl = TodoList()
    tl.write([_t("a")])
    r = tl.write([_t("b", "in_progress"), _t("c", "in_progress")])
    assert r.startswith("[Todo Error]")
    assert tl.items == [_t("a")]


def test_bad_status_rejected():
    tl = TodoList()
    assert tl.write([_t("a", "doing")]).startswith("[Todo Error]")
    assert tl.items == []


def test_other_invalid_input_rejected():
    tl = TodoList()
    assert tl.write("nope").startswith("[Todo Error]")
    assert tl.write({"content": "a"}).startswith("[Todo Error]")
    assert tl.write(["a"]).startswith("[Todo Error]")
    assert tl.write([_t("   ")]).startswith("[Todo Error]")
    assert tl.items == []


def test_prompt_block_format():
    tl = TodoList()
    tl.write([_t("one", "completed"), _t("two", "in_progress"), _t("three")])
    assert tl.prompt_block() == "Current todo:\n[x] one\n[>] two\n[ ] three"


def test_empty_block_is_blank():
    assert TodoList().prompt_block() == ""


def test_json_string_accepted():
    tl = TodoList()
    r = tl.write('[{"content": "a", "status": "pending"}]')
    assert r == "Todo list updated: 0/1 completed."


def test_status_case_insensitive_and_normalised():
    tl = TodoList()
    tl.write([{"content": "  a  ", "status": "Completed", "extra": 1}])
    assert tl.items == [_t("a", "completed")]


def test_empty_list_clears():
    tl = TodoList()
    tl.write([_t("a")])
    assert tl.write([]) == "Todo list updated: 0/0 completed."
    assert tl.items == []


def test_roundtrip_and_from_list_skips_invalid():
    tl = TodoList()
    tl.write([_t("a", "completed"), _t("b", "in_progress")])
    again = TodoList()
    again.from_list(tl.to_list())
    assert again.items == tl.items
    again.from_list([_t("ok"), "junk", {"content": "", "status": "pending"},
                     {"content": "x", "status": "bad"}, None])
    assert again.items == [_t("ok")]
    again.from_list(None)
    assert again.items == []


def test_todo_content_is_one_short_line():
    from aihub_code.todo import TodoList
    t = TodoList()
    t.write([{"content": "real step\n[x] fake done item\n\tmore", "status": "pending"},
             {"content": "y" * 500, "status": "pending"}])
    block = t.prompt_block()
    assert block.splitlines() == ["Current todo:", "[ ] real step [x] fake done item more",
                                  "[ ] " + "y" * 200]
