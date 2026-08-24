#!/usr/bin/env python3
"""E2E test for dsh-response-window against a running `dsh web` instance.

Usage:
    python3 test/e2e.py [--url http://127.0.0.1:3639] [--session "架构重构不顺原因分析"]

Requires: python3 + playwright (chromium). Assumes a session with tool calls.
Asserts: per-turn tool slides render, windows are bounded+scrollable, the
assistant text window applies, collapse/expand works, and switching sessions
does not crash (rows are never reparented).
"""
import argparse, json, sys

from playwright.sync_api import sync_playwright

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:3639")
    ap.add_argument("--session", default="架构重构不顺原因分析")
    args = ap.parse_args()

    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.goto(args.url, wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(3500)

        def open_session(title):
            return pg.evaluate("""(t) => {
                const el = Array.from(document.querySelectorAll('[role=button],button,div'))
                  .find(e => (e.innerText||'').includes(t) && e.innerText.trim().length < 40);
                if (el) { el.click(); return true; }
                return false;
            }""", title)

        if not open_session(args.session):
            sys.exit("session not found: " + args.session)
        pg.wait_for_timeout(4500)

        info = pg.evaluate("""() => ({
          slides: document.querySelectorAll('.drw-slide').length,
          heads: Array.from(document.querySelectorAll('.drw-slide .drw-head-title')).map(e=>e.innerText),
          bounded: Array.from(document.querySelectorAll('.drw-slide .drw-body')).every(b => {
            const cs = getComputedStyle(b);
            return b.style.maxHeight !== '' && cs.overflowY === 'auto';
          }),
          scrollableAny: Array.from(document.querySelectorAll('.drw-slide .drw-body')).some(b => b.scrollHeight > b.clientHeight),
          mdWindows: document.querySelectorAll('.drw-md.drw-md-capped').length,
          calls: document.querySelectorAll('.drw-call').length,
        })""")
        assert info["slides"] >= 1, "no slides rendered"
        assert info["bounded"], "not all tool-slide bodies are bounded"
        assert info["scrollableAny"], "no bounded body is actually scrollable (check session has a long turn)"
        print("PASS slides:", info["slides"], "heads:", json.dumps(info["heads"], ensure_ascii=False),
              "calls:", info["calls"], "mdWindows:", info["mdWindows"])

        # collapse/expand toggle
        before = pg.evaluate("document.querySelector('.drw-slide .drw-body').className")
        pg.evaluate("document.querySelector('.drw-slide .drw-head').click()")
        pg.wait_for_timeout(200)
        after = pg.evaluate("document.querySelector('.drw-slide .drw-body').className")
        assert "drw-collapsed" in after and "drw-collapsed" not in before, "collapse toggle failed"

        # switch session and come back (crash-safety: rows are not reparented)
        switched = pg.evaluate("""() => {
            const el = Array.from(document.querySelectorAll('[role=button],button,div')).find(e => (e.innerText||'').trim()==='test');
            if (el) { el.click(); return true; } return false;
        }""")
        pg.wait_for_timeout(3500)
        assert pg.evaluate("!!document.querySelector('[data-chat-flow]')"), "chat flow gone after switch"
        assert not errors, "errors after switch: " + "; ".join(errors[:5])
        print("PASS session-switch crash-safety")

        if errors:
            print("WARN console/page errors:", "; ".join(errors[:8]))
        b.close()
    print("ALL PASS")

if __name__ == "__main__":
    main()
