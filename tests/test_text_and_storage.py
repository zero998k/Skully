from bot.storage import Storage
from bot.text import split_message, strip_trace


def test_short_message_is_one_chunk():
    assert split_message("hello") == ["hello"]
    assert split_message("   ") == []


def test_long_message_splits_on_lines_under_limit():
    text = "\n".join(f"line {i} " + "x" * 50 for i in range(100))
    chunks = split_message(text, limit=500)
    assert all(len(c) <= 500 for c in chunks)
    assert "\n".join(chunks).replace("\n", "") == text.replace("\n", "")


def test_code_blocks_are_closed_and_reopened_across_chunks():
    code = "\n".join(f"print({i})" for i in range(200))
    text = f"Here you go:\n```python\n{code}\n```\nDone!"
    chunks = split_message(text, limit=400)
    assert len(chunks) > 2
    for chunk in chunks:
        assert len(chunk) <= 400
        assert chunk.count("```") % 2 == 0, chunk  # every chunk renders as complete code
    assert chunks[1].startswith("```python\n")
    assert chunks[-1].endswith("Done!")


def test_giant_single_line_is_hard_split():
    chunks = split_message("word " * 1000, limit=300)
    assert all(len(c) <= 300 for c in chunks)


def test_strip_trace():
    assert strip_trace("Answer here\n-# 🔎 searched \"x\"") == "Answer here"


def test_storage_memories_and_channels(tmp_path):
    path = str(tmp_path / "s.db")
    store = Storage(path)
    first = store.add_memory("guild:1", "  Zippe's   birthday is May 3 ", "Zippe")
    store.add_memory("guild:1", "Irnes holds BONK", "Irnes")
    assert [m.content for m in store.list_memories("guild:1")] == ["Zippe's birthday is May 3", "Irnes holds BONK"]
    assert store.delete_memory("guild:2", first) is False  # can't delete another server's memory
    assert store.delete_memory("guild:1", first) is True

    assert store.channel(5).autochat is False
    store.set_autochat(5, True)
    store.set_reset(5, 12345)
    store.close()

    reopened = Storage(path)  # survives restarts
    assert reopened.channel(5).autochat is True and reopened.channel(5).reset_after == 12345
    assert [m.content for m in reopened.list_memories("guild:1")] == ["Irnes holds BONK"]
    assert reopened.clear_memories("guild:1") == 1
