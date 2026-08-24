// dsh-plugin-response-window — browser half.
//
// What it does (Grok-build style response window):
//  1. PER-TURN TOOL SLIDE: every tool call of one turn (the response between
//     two user prompts) is grouped into ONE slide. The slide is ALWAYS
//     expanded by default and shows every call — state dot, tool name, one-line
//     summary, click to expand parameters/output — inside a bounded-height
//     scroll body (config `lines`, default 10). Nothing is hidden: it is a
//     window, not a summary. While calls are still running the body
//     auto-follows to the bottom.
//  2. ASSISTANT TEXT WINDOW: a settled assistant markdown block longer than
//     the window is capped with internal scroll + a subtle gradient and an
//     expand/collapse affordance. The native MarkdownText rendering is kept
//     untouched (class + CSS only).
//
// GUI-context safety contract (informed by code audit + a live React crash
// experiment):
//  - Moving React-owned chat rows into a wrapper container is NOT safe: when
//    DSH later removes a moved row (session switch / edit / compaction), React
//    calls parent.removeChild(row) which throws because the row is no longer a
//    direct child, and the whole conversation tree unmounts. Therefore this
//    plugin NEVER moves [data-chat-anchor-key] rows.
//  - The tool slide is implemented at the React layer via a low-priority slot
//    shadow of `conversation.chat.node` (key `tool-call`, priority -100), the
//    same proven technique as dsh-tool-summary: the first tool-call node of a
//    turn renders the slide, every sibling tool-call node of the same turn
//    renders null, and any render error abdicates to the built-in renderer.
//  - The assistant text window is class/CSS only (like dsh-toolbox-web's long
//    message fold) — no DOM reparenting, no removal of React-owned nodes.
//  - The plugin never writes the session snapshot and never calls host APIs;
//    it only reads the snapshot (useSession selectors) and styles DOM.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-response-window',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var runtimeClient = require('@deepseek-ai/dsh-client-runtime/client')
    var createSnapshotStore = runtimeClient.createSnapshotStore

    // ---- config -----------------------------------------------------------
    var DEFAULTS = {
      lines: 10,
      collapsed: false,
      showReadOnly: true,
      minCollapseRows: 3,
    }
    function clampInt(value, min, max, fallback) {
      var n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }
    function readConfig(cfg) {
      cfg = cfg || {}
      return {
        lines: clampInt(cfg.lines, 0, 200, DEFAULTS.lines),
        collapsed: cfg.collapsed === true,
        showReadOnly: cfg.showReadOnly !== false,
        minCollapseRows: clampInt(cfg.minCollapseRows, 1, 50, DEFAULTS.minCollapseRows),
      }
    }

    // ---- live settings state ----------------------------------------------
    // `lines` is user-adjustable from Settings; the rest come from row config.
    var linesStore = null
    var settingsScope = null
    var NS = 'dsh-plugin-response-window'
    function clampLines(value) { return clampInt(value, 0, 200, DEFAULTS.lines) }

    /** Minimal observable-value hook over a SnapshotStore (plain React). */
    function useStoreValue(store) {
      var pair = React.useState(function () { return store === null ? DEFAULTS.lines : store.getSnapshot() })
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () {
        if (store === null) return undefined
        var unsub = store.subscribe(function () { setValue(store.getSnapshot()) })
        setValue(store.getSnapshot())
        return unsub
      }, [store])
      return value
    }

    /** Live window size in lines (follows the Settings store). */
    function useLiveLines() {
      return useStoreValue(linesStore)
    }

    // ---- shared style injection ------------------------------------------
    var STYLE_ID = 'dsh-plugin-response-window-css'
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = [
        /* per-turn tool slide */
        '.drw-slide {',
        '  position: relative;',
        '  display: flex; flex-direction: column;',
        '  margin: 6px 0;',
        '  border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.35));',
        '  border-radius: 10px;',
        '  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06));',
        '  overflow: hidden;',
        '}',
        '.drw-slide[data-running="1"] { border-color: var(--dsw-alias-brand, #3dbbf5); }',
        /* Tool-call rows that our per-turn slide renders null for (sibling
           nodes of a grouped turn) are empty in the DOM: hide the leftover
           ~0-height stubs. Only truly empty rows match, so a native fallback
           (renderer abdication) staying non-empty is never hidden. */
        '[data-chat-flow-kind="tool-call"]:empty { display: none; }',
        '[data-chat-flow-kind][data-drw-stub="1"] { display: none !important; }',
        /* Assistant-step carrying only a slide-hidden Think (no staged text,
           no slide) is a 0-height ghost: hide it instantly by selector, so a
           late JS scan can never leave the extra bottom gap behind. */
        '[data-chat-flow-kind="assistant-step"]:not(:has(.drw-slide)):not(:has([class*="_markdown"])):has([data-variant="think"][data-drw-hidethink="1"]) { display: none; }',
        '.drw-head {',
        '  display: flex; align-items: center; gap: 8px;',
        '  padding: 6px 10px;',
        '  cursor: pointer; user-select: none;',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  font-size: 12.5px; line-height: 1.4;',
        '  background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.10));',
        '}',
        '.drw-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); }',
        '.drw-head-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.drw-head-badge {',
        '  font-size: 11px; line-height: 1; padding: 2px 7px; border-radius: 999px;',
        '  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.2));',
        '  color: var(--dsw-alias-label-secondary, #bbb);',
        '  white-space: nowrap;',
        '}',
        '.drw-head-badge[data-state="running"] { color: #3dbbf5; }',
        '.drw-head-badge[data-state="error"] { color: #ee5858; }',
        '.drw-head-toggle { margin-left: auto; color: var(--dsw-alias-label-secondary, #bbb); font-size: 11.5px; }',
        '.drw-body { overflow-y: auto; overscroll-behavior: contain; }',
        '.drw-body.drw-collapsed { display: none; }',
        '.drw-call { border-top: 1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.16)); }',
        '.drw-call:first-child { border-top: none; }',
        '.drw-row {',
        '  display: flex; align-items: center; gap: 7px;',
        '  padding: 5px 10px;',
        '  cursor: pointer; user-select: none;',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  font-size: 12.5px; line-height: 1.35;',
        '}',
        '.drw-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10)); }',
        '.drw-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }',
        '.drw-dot[data-state="ok"] { background: #34d59a; }',
        '.drw-dot[data-state="running"] { background: #3dbbf5; animation: drwPulse 1s ease-in-out infinite; }',
        '.drw-dot[data-state="error"] { background: #ee5858; }',
        '.drw-dot[data-state="stopped"] { background: #c9a227; }',
        '@keyframes drwPulse { 50% { opacity: 0.35; } }',
        '.drw-row-name { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; white-space: nowrap; }',
        '.drw-row-summary { color: var(--dsw-alias-label-secondary, #bbb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }',
        '.drw-inspect { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #bbb); cursor: pointer; padding: 0 2px; font-size: 12px; }',
        '.drw-inspect:hover { color: var(--dsw-alias-label-primary, #eee); }',
        '.drw-chevron { color: var(--dsw-alias-label-secondary, #bbb); font-size: 10px; transition: transform 0.12s ease; }',
        '.drw-chevron[data-open="1"] { transform: rotate(90deg); }',
        '.drw-row-body { padding: 2px 10px 8px 28px; }',
        '.drw-row-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, #888); margin: 6px 0 3px; }',
        '.drw-row-pre {',
        '  margin: 0; padding: 6px 8px;',
        '  border-radius: 6px;',
        '  background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.25));',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  font: var(--dsw-font-markdown-code-block-small, 12px/1.5 ui-monospace, monospace);',
        '  white-space: pre-wrap; word-break: break-word;',
        '  max-height: 10em; overflow-y: auto;',
        '}',
        /* Think (reasoning) rows inside the slide — one line each, like tool rows */
        '.drw-think { border-top: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.16)); flex: none; }',
        '.drw-think-head { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 10px; cursor: pointer; user-select: none; border-radius: 8px; }',
        '.drw-think-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08)); }',
        '.drw-think-name { color: var(--dsw-alias-label-secondary, #bbb); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; flex: none; }',
        '.drw-think-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #999); font-size: 12.5px; flex: 1 1 auto; }',
        '.drw-think-toggle { color: var(--dsw-alias-label-tertiary, #888); font-size: 10px; flex: none; }',
        '.drw-think-body { margin: 0; padding: 6px 8px; color: var(--dsw-alias-label-primary, #eee); font: var(--dsw-font-markdown-code-block-small, 12px/1.5 ui-monospace, monospace); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; }',
        /* Hide the native Think row once it's inside a slide (DOM + CSS only) */
        '[data-variant="think"][data-drw-hidethink="1"] { display: none !important; }',
        /* Settings row: response window size */
        '.drw-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 16px 0 18px; }',
        '.drw-set-text { min-width: 0; }',
        '.drw-set-title { color: var(--dsw-alias-label-primary, #eee); font-size: 14px; font-weight: 400; line-height: 22px; }',
        '.drw-set-desc { color: var(--dsw-alias-label-tertiary, #9296a0); font-size: 12px; line-height: 18px; margin-top: 3px; }',
        '.drw-set-control { display: flex; align-items: center; gap: 6px; flex: none; }',
        '.drw-set-btn {',
        '  border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.35));',
        '  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08));',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  border-radius: 8px; height: 28px; min-width: 28px; padding: 0 8px; cursor: pointer;',
        '  font-size: 14px; line-height: 1;',
        '}',
        '.drw-set-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); }',
        '.drw-set-btn:disabled { opacity: 0.4; cursor: default; }',
        '.drw-set-input {',
        '  width: 56px; height: 28px; text-align: center;',
        '  border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.35));',
        '  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #1c1c20);',
        '  color: var(--dsw-alias-label-primary, #eee); font-size: 13px;',
        '}',
      ].join('\n')
      ;(document.head || document.documentElement).appendChild(el)
    }

    // ---- tool data helpers (adapted from dsh-tool-summary, MIT) -----------
    var READONLY_TOOLS = new Set([
      'read', 'grep', 'glob', 'web_search', 'web_fetch', 'search', 'ls', 'find', 'list',
    ])
    function turnNumber(node) {
      var location = node && node.location
      if (!location) return undefined
      if (location.kind === 'turn' || location.kind === 'step') {
        var t = location.turn
        return t && typeof t.turn === 'number' ? t.turn : undefined
      }
      return undefined
    }
    function callName(block) {
      return block && ('kind' in block ? (block.call && block.call.name) || '' : block.name) || ''
    }
    function isRunning(block) {
      return !(block && 'kind' in block)
    }
    function resultText(block) {
      if (!block || !('kind' in block)) return ''
      var parts = []
      var content = block.content || []
      for (var i = 0; i < content.length; i++) {
        var c = content[i]
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      }
      return parts.join('\n')
    }
    function callSummary(block) {
      var name = callName(block)
      var raw = (block && ('kind' in block ? (block.call && block.call.argsRaw) || '' : block.argsRaw)) || ''
      if (raw === '') return name
      try {
        var parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return name + ' · ' + raw
        for (var i = 0; i < KEYS.length; i++) {
          var value = parsed[KEYS[i]]
          if (typeof value === 'string' && value !== '') return value
        }
        return name + ' · ' + raw.slice(0, 80)
      } catch (e) {
        return name + ' · ' + raw.slice(0, 80)
      }
    }
    var KEYS = ['file_path', 'path', 'command', 'url', 'pattern', 'query']
    function computeStats(blocks) {
      var counts = Object.create(null)
      var total = 0, running = 0, errors = 0, readOnly = 0
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i]
        if (!block) continue
        var name = callName(block)
        total += 1
        counts[name] = (counts[name] || 0) + 1
        if (isRunning(block)) running += 1
        else if (block.isError) errors += 1
        if (READONLY_TOOLS.has(name)) readOnly += 1
      }
      return { total: total, running: running, errors: errors, readOnly: readOnly, counts: counts }
    }

    // ---- one compact tool row ----------------------------------------------
    function SimpleToolRow(props) {
      var block = props.block
      var openFile = props.openFile
      var inspectCall = props.inspectCall
      var state = React.useState(false)
      var open = state[0]
      var setOpen = state[1]
      var running = isRunning(block)
      var name = callName(block)
      var raw = (block && ('kind' in block ? (block.call && block.call.argsRaw) || '' : block.argsRaw)) || ''
      var output = resultText(block)
      var failed = !running && !!(block && block.isError)
      var stopped = !running && !!(block && block.error) && !failed
      var stateName = running ? 'running' : failed ? 'error' : stopped ? 'stopped' : 'ok'
      return React.createElement('div', { className: 'drw-call', 'data-state': stateName },
        React.createElement('div', {
          className: 'drw-row', role: 'button', tabIndex: 0,
          'aria-expanded': open || undefined,
          onClick: function () { setOpen(!open) },
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } },
        },
          React.createElement('span', { className: 'drw-dot', 'data-state': stateName, 'aria-hidden': true }),
          React.createElement('span', { className: 'drw-row-name', title: name }, name || (block && block.callId) || 'tool'),
          React.createElement('span', { className: 'drw-row-summary', title: output || raw }, callSummary(block)),
          typeof inspectCall === 'function'
            ? React.createElement('button', {
                type: 'button', className: 'drw-inspect', title: '在轨迹中查看', 'aria-label': '在轨迹中查看 ' + name,
                onClick: function (e) { e.stopPropagation(); inspectCall(block.callId) },
              }, '\u2934')
            : null,
          React.createElement('span', { className: 'drw-chevron', 'data-open': open ? '1' : undefined, 'aria-hidden': true }, '\u25B6'),
        ),
        open
          ? React.createElement('div', { className: 'drw-row-body' },
              raw !== ''
                ? React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'drw-row-label' }, '参数'),
                    React.createElement('pre', { className: 'drw-row-pre' }, raw),
                  )
                : null,
              output !== ''
                ? React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'drw-row-label' }, '输出'),
                    React.createElement('pre', { className: 'drw-row-pre' }, output),
                  )
                : null,
              raw === '' && output === ''
                ? React.createElement('div', { className: 'drw-row-pre' }, running ? '执行中…' : '无输出')
                : null,
            )
          : null,
      )
    }

    // ---- one think (reasoning) row inside the slide -------------------------
    // A compact single-line row, collapsible to the full reasoning text — the
    // same look and feel as a tool-call row (think and tool calls are both
    // "implementation" and should read the same inside the window).
    function ThinkRow(props) {
      var text = props.text
      var index = props.index
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var firstLine = text.split('\n')[0].trim() || text.trim()
      var summary = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
      return React.createElement('div', { className: 'drw-think', 'data-open': open ? '1' : undefined },
        React.createElement('div', {
          className: 'drw-think-head', role: 'button', tabIndex: 0,
          'aria-expanded': open || undefined,
          onClick: function () { setOpen(!open) },
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } },
        },
          React.createElement('span', { className: 'drw-think-name' }, 'Think ' + (index + 1)),
          React.createElement('span', { className: 'drw-think-summary', title: firstLine }, summary),
          React.createElement('span', { className: 'drw-think-toggle', 'aria-hidden': true }, open ? '\u25BE' : '\u25B8'),
        ),
        open
          ? React.createElement('pre', { className: 'drw-think-body' }, text)
          : null,
      )
    }

    // ---- the per-turn slide -------------------------------------------------
    // One slide = one implementation segment: think + tool calls kept in their
    // exact output order (not think-on-top / bash-on-bottom), all inside the
    // same bounded scroll window.
    function TurnSlide(props) {
      var items = props.items || []
      var turn = props.turn
      var segmentIndex = props.segmentIndex
      var segmentCount = props.segmentCount
      var cwd = props.cwd
      var openFile = props.openFile
      var inspectCall = props.inspectCall
      var cfg = props.config
      var lines = useLiveLines() // live window size from Settings
      var toolItems = items.filter(function (it) { return it.kind === 'tool' })
      var reasoningCount = items.reduce(function (acc, it) { return it.kind === 'think' ? acc + 1 : acc }, 0)
      var stats = React.useMemo(function () {
        return computeStats(toolItems.map(function (it) { return it.node.data.root }))
      }, [items])
      var openState = React.useState(!cfg.collapsed)
      var open = openState[0]
      var setOpen = openState[1]
      var bodyRef = React.useRef(null)
      var running = stats.running > 0
      // Auto-follow to the bottom while calls are still running.
      React.useEffect(function () {
        if (!open || !bodyRef.current) return
        if (running) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      })
      var list = items
      if (!cfg.showReadOnly) {
        list = items.filter(function (it) {
          return it.kind === 'think' || !READONLY_TOOLS.has(callName(it.node.data.root))
        })
      }
      var thinkSeen = 0
      return React.createElement('div', { className: 'drw-slide', 'data-running': running ? '1' : undefined },
        React.createElement('div', {
          className: 'drw-head', role: 'button', tabIndex: 0,
          'aria-expanded': open || undefined,
          onClick: function () { setOpen(!open) },
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } },
        },
          React.createElement('span', { className: 'drw-head-title' },
            stats.total + ' 个工具调用'
              + (reasoningCount > 0 ? ' · ' + reasoningCount + ' Think' : '')
          ),
          running
            ? React.createElement('span', { className: 'drw-head-badge', 'data-state': 'running' }, '进行中')
            : null,
          !running && stats.errors > 0
            ? React.createElement('span', { className: 'drw-head-badge', 'data-state': 'error' }, '⚠ ' + stats.errors)
            : null,
          !cfg.showReadOnly && stats.readOnly > 0
            ? React.createElement('span', { className: 'drw-head-badge' }, '隐藏只读 ' + stats.readOnly)
            : null,
          React.createElement('span', { className: 'drw-head-toggle' }, open ? '收起 ▴' : '展开 ▾'),
        ),
        React.createElement('div', {
          ref: bodyRef,
          className: 'drw-body' + (open ? '' : ' drw-collapsed'),
          style: open && lines > 0 ? { maxHeight: (lines * 1.55) + 'em' } : undefined,
        },
          list.map(function (it) {
            if (it.kind === 'think') {
              var tid = thinkSeen
              thinkSeen += 1
              return React.createElement(ThinkRow, { key: 'think-' + tid, text: it.text, index: tid })
            }
            return React.createElement(SimpleToolRow, {
              key: it.node.key,
              block: it.node.data.root,
              cwd: cwd,
              openFile: openFile,
              inspectCall: inspectCall,
            })
          }),
        ),
      )
    }

    // ---- response-segment grouping -------------------------------------------
    // A "staged response" is an assistant step that returns visible text to the
    // user mid-turn. Each chunk of implementation (think + tool calls) between
    // two staged responses becomes its own slide — not one giant slide per user
    // prompt pair.
    function hasVisibleTextBlock(blocks) {
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i]
        if (b && b.kind === 'text' && typeof b.text === 'string' && b.text.trim() !== '') return true
      }
      return false
    }

    function buildTurnSegments(order, chat) {
      var segments = []
      var current = null
      function ensure() {
        if (current === null) {
          current = { items: [], tools: [], startKey: null }
          segments.push(current)
        }
        return current
      }
      function closeSegment() { current = null }
      for (var i = 0; i < order.length; i++) {
        var n = chat.nodes.get(order[i])
        if (n === undefined) continue
        if (n.kind === 'user') { closeSegment(); continue }
        if (n.kind === 'assistant-step') {
          var blocks = n.data && Array.isArray(n.data.blocks) ? n.data.blocks : []
          var staged = hasVisibleTextBlock(blocks)
          // The reasoning of this step belongs to the chunk leading up to the
          // staged response (i.e. the segment that ends here), and it keeps its
          // exact output position among the tools.
          for (var b = 0; b < blocks.length; b++) {
            var block = blocks[b]
            if (block && block.kind === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
              ensure().items.push({ kind: 'think', text: block.text })
            }
          }
          if (staged) closeSegment()
          continue
        }
        if (n.kind === 'tool-call') {
          var seg = ensure()
          if (seg.startKey === null) seg.startKey = n.key
          seg.items.push({ kind: 'tool', node: n })
          seg.tools.push(n)
          continue
        }
      }
      // Only segments that actually have tool calls get a slide (that is where
      // the slot shadow mounts); think-only chunks stay native.
      return segments.filter(function (s) { return s.tools.length > 0 })
    }

    // ---- slot component: one slide per response segment, siblings null ------
    function ToolTurnSlide(props) {
      var node = props.node
      var useSession = props.useSession
      var cwd = props.cwd
      var openFile = props.openFile
      var inspectCall = props.inspectCall
      var turn = turnNumber(node)
      var EMPTY = { turn: turn, segments: [] }
      var snapData = useSession(function (snapshot) {
        if (turn === undefined || !snapshot || !snapshot.chat || !snapshot.chat.locations) return EMPTY
        var chat = snapshot.chat
        var order = chat.locations.getTurn(turn)
        return { turn: turn, segments: buildTurnSegments(order, chat) }
      })
      var segments = snapData.segments
      try {
        if (!segments || segments.length === 0) return null
        var segIndex = -1
        for (var i = 0; i < segments.length; i++) {
          if (segments[i].startKey === node.key) { segIndex = i; break }
        }
        if (segIndex < 0) return null
        var seg = segments[segIndex]
        return React.createElement(TurnSlide, {
          items: seg.items,
          turn: turn,
          segmentIndex: segments.length > 1 ? segIndex : undefined,
          segmentCount: segments.length,
          cwd: cwd,
          openFile: openFile,
          inspectCall: inspectCall,
          config: currentConfig,
        })
      } catch (e) {
        return null
      }
    }

    // Leftover ~0-height placeholders: for every tool-call node that is not a
    // segment start our slot renders null, but DSH still keeps an (almost)
    // empty flow item per stubbed tool call. Those items fail `:empty` (they
    // carry an inner node) so they keep occupying a flex gap slot (~16px
    // each) between the slide and the next staged response — inflating the
    // gap with the segment's tool-call count. Mark them and hide for real.
    function markStubs(root) {
      // Tool-call placeholders: every non-segment-start tool-call renders an
      // (almost) empty flow item from our null slot.
      var rows = root.querySelectorAll('[data-chat-flow-kind="tool-call"]')
      for (var i = 0; i < rows.length; i++) {
        var e = rows[i]
        var isStub = !e.querySelector('.drw-slide') && (e.textContent || '').trim() === ''
        if (isStub) e.dataset.drwStub = '1'
        else if (e.dataset.drwStub) delete e.dataset.drwStub
      }
      // Assistant-step rows that only held a reasoning block: once the native
      // think is folded into the slide (hidden), the whole row is 0-height but
      // still occupies a flex gap slot between the slide and the next response.
      // Hide such ghost rows too — but never while streaming (content may come).
      var steps = root.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
      for (var j = 0; j < steps.length; j++) {
        var s = steps[j]
        if (s.querySelector('.drw-slide')) { if (s.dataset.drwStub) delete s.dataset.drwStub; continue }
        if (s.closest('[data-streaming]')) { if (s.dataset.drwStub) delete s.dataset.drwStub; continue }
        var h = s.getBoundingClientRect().height
        if (h < 2) s.dataset.drwStub = '1'
        else if (s.dataset.drwStub) delete s.dataset.drwStub
      }
    }

    // Hide native Think rows that belong to a turn with a slide, so the same
    // reasoning does not appear both inside the slide and inline in the flow.
    // Only DOM class toggling — never reparents React-owned rows.
    function hideNativeThink(root) {
      var flow = root.querySelector('[data-chat-flow]')
      if (!flow || !flow.children) return
      var rows = []
      for (var i = 0; i < flow.children.length; i++) rows.push(flow.children[i])
      // Segment boundary in the DOM: a user row, or an assistant-step row that
      // carries visible staged text (a response shown to the user mid-turn).
      function isSegmentBoundary(row) {
        if (row.matches && row.matches('[data-chat-flow-kind="user"]')) return true
        if (!row.matches || !row.matches('[data-chat-flow-kind="assistant-step"]')) return false
        var md = row.querySelector('[class*="_markdown"]')
        return md !== null && md.textContent.trim() !== ''
      }
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r]
        if (!row || !row.querySelector) continue
        var think = row.matches && row.matches('[data-variant="think"]') ? row : row.querySelector('[data-variant="think"]')
        if (!think) continue
        var hasSlide = false
        for (var j = r - 1; j >= 0; j--) {
          var prev = rows[j]
          if (!prev || !prev.matches) continue
          if (isSegmentBoundary(prev)) break
          if (prev.querySelector && prev.querySelector('.drw-slide')) { hasSlide = true; break }
        }
        for (var k = r + 1; k < rows.length && !hasSlide; k++) {
          var next = rows[k]
          if (!next || !next.matches) continue
          if (isSegmentBoundary(next)) break
          if (next.querySelector && next.querySelector('.drw-slide')) { hasSlide = true; break }
        }
        if (hasSlide) think.dataset.drwHidethink = '1'
        else if (think.dataset.drwHidethink) delete think.dataset.drwHidethink
      }
    }

    // Invisible per-session dock that watches the conversation scroller and
    // keeps native Think rows in sync with the slides (session-scoped).
    function TextWindowDock(props) {
      var mountRef = React.useRef(null)
      React.useEffect(function () {
        var mount = mountRef.current
        if (!mount) return
        var scroller = mount.closest('[data-conversation-scroll]')
        var root = scroller || document.body
        var timer = null
        var bootTimer = null
        var scan = function () {
          try { markStubs(root) } catch (e) {}
          try { hideNativeThink(root) } catch (e) {}
        }
        // Session switch renders the new rows in bursts; a debounce makes the
        // stub hiding lag behind by hundreds of ms, during which the 0-height
        // placeholder rows inflate the gap below a slide. Scan on the same
        // animation frame the mutation lands (throttled to one per frame), so
        // the fix is in place before the next paint — no visible flicker.
        var schedule = function () {
          if (timer != null) return
          timer = requestAnimationFrame(function () {
            timer = null
            scan()
            // trailing pass: rows that landed between the mutation and paint
            window.setTimeout(scan, 80)
          })
        }
        scan()
        var observer = new MutationObserver(function () { schedule() })
        observer.observe(root, { childList: true, subtree: true })
        // Re-scan shortly after mount for already-settled history.
        bootTimer = setTimeout(scan, 200)
        return function () {
          observer.disconnect()
          if (timer != null) cancelAnimationFrame(timer)
          clearTimeout(bootTimer)
        }
      }, [props.sessionId])
      return React.createElement('div', { ref: mountRef, 'data-drw-dock': '', style: { display: 'none' } })
    }

    // ---- Settings row: response window size ---------------------------------
    function ResponseWindowSettingsRow(props) {
      var useLines = props.useLines
      var setLines = props.setLines
      var lines = (typeof useLines === 'function' ? useLines(function (s) { return s }) : null) ?? currentConfig.lines
      var value = clampLines(lines)
      var step = function (delta) {
        setLines(value + delta)
      }
      return React.createElement('div', { className: 'drw-set-row' },
        React.createElement('div', { className: 'drw-set-text' },
          React.createElement('div', { className: 'drw-set-title' }, '响应窗口大小（行数）'),
          React.createElement('div', { className: 'drw-set-desc' }, '每个响应 slide 的限高滚动窗口。默认 10 行，0 = 不限高，改动即时生效。'),
        ),
        React.createElement('div', { className: 'drw-set-control' },
          React.createElement('button', {
            type: 'button', className: 'drw-set-btn', 'aria-label': '减小窗口',
            disabled: value <= 0,
            onClick: function () { step(-1) },
          }, '−'),
          React.createElement('input', {
            type: 'number', className: 'drw-set-input', min: 0, max: 200, step: 1, value: String(value),
            onChange: function (e) { setLines(e.target.value) },
          }),
          React.createElement('button', {
            type: 'button', className: 'drw-set-btn', 'aria-label': '增大窗口',
            disabled: value >= 200,
            onClick: function () { step(1) },
          }, '+'),
        ),
      )
    }

    // ---- plugin entry -------------------------------------------------------
    var currentConfig = readConfig(null)

    var INJECT = ['slots', 'settingsScope']
    function apply(ctx, config) {
      currentConfig = readConfig(config)
      injectStyles()

      // Durable settings binding: the host half registered the `dsh-plugin-response-window`
      // namespace; the browser scope mirrors it and persists user overrides.
      linesStore = createSnapshotStore(currentConfig.lines)
      var scopeService = null
      try { scopeService = ctx.get('settingsScope') } catch (e) { scopeService = null }
      if (scopeService && typeof scopeService.bind === 'function') {
        try {
          settingsScope = scopeService.bind({ namespace: NS })
        } catch (e) {
          settingsScope = null
        }
      }
      if (settingsScope !== null) {
        var adopt = function () {
          try {
            var snap = settingsScope.getSnapshot()
            var value = snap && snap.value
            if (value && typeof value.lines === 'number') {
              var n = clampLines(value.lines)
              if (linesStore !== null && linesStore.getSnapshot() !== n) linesStore.set(n)
            }
          } catch (e) {}
        }
        settingsScope.subscribe(adopt)
        adopt()
      }

      ctx.slots.inject('conversation.chat.node', function () {
        return ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'tool-call',
          priority: -100,
          locale: 'conversation',
        }, ToolTurnSlide)
      })

      // Always mounted: hides native Think rows (core feature) and optionally
      // applies the bounded window to long assistant markdown.
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-plugin-response-window',
          order: 90,
        }, TextWindowDock)
      })

      // Settings → General row for the window size (live, persisted).
      ctx.slots.inject('settings.general.item', function () {
        return ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-plugin-response-window',
          order: 60,
          inject: function () {
            return {
              hooks: { lines: linesStore },
              setLines: function (value) {
                var n = clampLines(value)
                if (linesStore !== null && linesStore.getSnapshot() === n && n !== 0) {
                  // same value, no-op
                }
                if (linesStore !== null) linesStore.set(n)
                if (settingsScope !== null) {
                  settingsScope.set('lines', n).catch(function () {})
                }
              },
            }
          },
        }, ResponseWindowSettingsRow)
      })
    }

    exports.apply = apply
    exports.inject = INJECT
    Object.defineProperty(exports, '__esModule', { value: true })
    return module.exports
  },
})
