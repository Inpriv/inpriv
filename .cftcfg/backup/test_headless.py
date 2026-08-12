"""Headless verification for cftcfg TUI (textual run_test) and GUI (tkinter)."""
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cftcfg

SAMPLE = """tunnel: my-tunnel
credentials-file: C:\\Users\\mckkw\\.cloudflared\\abc-123.json
ingress:
  - hostname: pay.inpriv.xyz
    service: http://127.0.0.1:3000
  - hostname: api.inpriv.xyz
    service: http://127.0.0.1:8080
  - service: http_status:404
"""

PASS = []


def ok(name):
    PASS.append(name)
    print(f"  PASS: {name}")


def make_env():
    tmp = Path(tempfile.mkdtemp(prefix="cftcfg-tui-"))
    config = tmp / "config.yml"
    config.write_text(SAMPLE, encoding="utf-8")
    settings = cftcfg.Settings(tmp / "settings.json")
    settings["first_run_done"] = True
    settings.save()
    manager = cftcfg.ConfigManager(config)
    session = cftcfg.ConfigSession(manager, settings)
    return tmp, session, settings


async def test_tui_crud():
    from textual.widgets import DataTable, Input, Static

    tmp, session, settings = make_env()
    app = cftcfg._build_textual_app(session, settings)
    async with app.run_test(size=(110, 35)) as pilot:
        table = app.query_one("#rules", DataTable)
        assert table.row_count == 3, f"expected 3 rows, got {table.row_count}"
        ok("table renders 3 rules")

        await pilot.press("a")
        await pilot.pause()
        app.screen.query_one("#in-hostname", Input).value = "wiki.inpriv.xyz"
        app.screen.query_one("#in-service", Input).value = "http://127.0.0.1:4000"
        await pilot.click("#save")
        await pilot.pause()
        assert session.dirty, "session should be dirty after add"
        assert app.query_one("#rules", DataTable).row_count == 4
        hostnames = [r.hostname for r in session.config.rules()]
        assert hostnames[2] == "wiki.inpriv.xyz", f"insert position wrong: {hostnames}"
        ok("add rule inserts before catch-all and marks dirty")

        await pilot.press("s")
        await pilot.pause()
        assert not session.dirty
        text = session.manager.path.read_text(encoding="utf-8")
        assert "wiki.inpriv.xyz" in text
        assert session.manager.backups(), "backup should exist after save"
        ok("save persists file and writes backup")

        await pilot.press("d")
        await pilot.pause()
        await pilot.click("#ok")
        await pilot.pause()
        hostnames = [r.hostname for r in session.config.rules()]
        assert "pay.inpriv.xyz" not in hostnames, hostnames
        ok("delete rule with confirm modal")

        table = app.query_one("#rules", DataTable)
        table.move_cursor(row=table.row_count - 1)
        await pilot.pause()
        await pilot.press("e")
        await pilot.pause()
        assert app.screen.query_one("#in-service", Input) is not None
        app.screen.query_one("#in-service", Input).value = "http_status:503"
        await pilot.click("#save")
        await pilot.pause()
        catch_all = session.config.rules()[-1]
        assert catch_all.is_catch_all and catch_all.service == "http_status:503"
        ok("edit catch-all via modal")

        await pilot.press("v")
        await pilot.pause(0.8)
        status = str(app.query_one("#statusbar", Static).render())
        assert "structure OK" in status, status
        ok(f"validate updates status bar ({status[:70]}...)")

        await pilot.press("s")
        await pilot.pause()
        assert not session.dirty
        await pilot.press("q")
        await pilot.pause()
    ok("clean quit without confirm when saved")


async def test_tui_first_run():
    tmp, session, settings = make_env()
    settings["first_run_done"] = False
    settings.save()
    app = cftcfg._build_textual_app(session, settings)
    async with app.run_test(size=(110, 35)) as pilot:
        await pilot.pause()
        await pilot.click("#no")
        await pilot.pause()
    reloaded = cftcfg.Settings(settings.path)
    assert reloaded.get("first_run_done") is True
    ok("first-run modal dismissed, preference persisted")


def test_gui_smoke():
    tmp, session, settings = make_env()
    gui = cftcfg._build_gui(session, settings)
    gui.root.update_idletasks()
    rows = gui.tree.get_children()
    assert len(rows) == 3, f"expected 3 tree rows, got {len(rows)}"
    first = gui.tree.item(rows[0])["values"]
    assert first[0] == "pay.inpriv.xyz" and first[1] == "http://127.0.0.1:3000", first
    last = gui.tree.item(rows[-1])["values"]
    assert last[0] == "<catch-all>", last
    gui.root.after(150, gui.root.destroy)
    assert gui.run() == 0
    ok("GUI builds, populates treeview, closes cleanly")


async def main():
    print("TUI tests:")
    await test_tui_crud()
    await test_tui_first_run()
    print("GUI tests:")
    test_gui_smoke()
    print(f"\nALL {len(PASS)} CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
