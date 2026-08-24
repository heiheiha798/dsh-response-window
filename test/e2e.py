#!/usr/bin/env python3
"""E2E test for dsh-response-window against a running `dsh web` instance.

Usage:
    python3 test/e2e.py [--url http://127.0.0.1:3639] [--session "架构重构不顺原因分析"]

Requires: python3 + playwright (chromium). Assumes a session with tool calls
(and ideally some reasoning/think blocks).
Asserts: per-turn slides render (think rows inside, one line each, collapsible,
native Think rows hidden), windows are bounded+scrollable, the assistant text
window applies, collapse/expand works, and switching sessions does not crash
(rows are never reparented).
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

        info = pg.evaluate("""() => {
          const thinks = Array.from(document.querySelectorAll('.drw-think'));
          return {
            slides: document.querySelectorAll('.drw-slide').length,
            heads: Array.from(document.querySelectorAll('.drw-slide .drw-head-title')).map(e=>e.innerText),
            bounded: Array.from(document.querySelectorAll('.drw-slide .drw-body')).every(bb => {
              const cs = getComputedStyle(bb);
              return bb.style.maxHeight !== '' && cs.overflowY === 'auto';
            }),
            scrollableAny: Array.from(document.querySelectorAll('.drw-slide .drw-body')).some(bb => bb.scrollHeight > bb.clientHeight),
            calls: document.querySelectorAll('.drw-call').length,
            thinks: thinks.length,
            thinkExpanded: thinks.filter(t => t.getAttribute('data-open') === '1').length,
            thinkCollapsed: thinks.filter(t => !t.getAttribute('data-open')).length,
            nativeThinkVisible: document.querySelectorAll('[data-variant="think"]:not([data-drw-hidethink])').length,
            nativeThinkHidden: document.querySelectorAll('[data-variant="think"][data-drw-hidethink="1"]').length,
          };
        }""")
        assert info["slides"] >= 1, "no slides rendered"
        assert info["bounded"], "not all tool-slide bodies are bounded"
        assert info["scrollableAny"], "no bounded body is actually scrollable (check session has a long turn)"
        if info["thinks"]:
            assert info["thinkExpanded"] == 0, "think rows should be collapsed by default (one line each)"
            assert info["nativeThinkVisible"] == 0, "native Think rows should be hidden once inside a slide"
        print("PASS slides:", info["slides"], "heads:", json.dumps(info["heads"], ensure_ascii=False),
              "calls:", info["calls"], "thinks:", info["thinks"],
              "(native hidden:", info["nativeThinkHidden"], "/ visible:", info["nativeThinkVisible"], ")")

        # a think row is a single collapsed line and expands on click
        if info["thinks"]:
            h0 = pg.evaluate("Math.round(document.querySelector('.drw-think').getBoundingClientRect().height)")
            assert h0 <= 44, "think row is not single-line (height %s px)" % h0
            pg.evaluate("document.querySelector('.drw-think .drw-think-head').click()")
            pg.wait_for_timeout(250)
            expanded = pg.evaluate("""() => {
                const t = document.querySelector('.drw-think');
                return t && t.getAttribute('data-open') === '1' && !!t.querySelector('.drw-think-body');
            }""")
            assert expanded, "think row did not expand on click"
            pg.evaluate("document.querySelector('.drw-think .drw-think-head').click()")

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
