// dsh-response-window — browser half.
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
  id: 'dsh-response-window',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ---- config -----------------------------------------------------------
    var DEFAULTS = {
      lines: 10,
      collapsed: false,
      showReadOnly: true,
      wrapAssistantText: true,
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
        wrapAssistantText: cfg.wrapAssistantText !== false,
        minCollapseRows: clampInt(cfg.minCollapseRows, 1, 50, DEFAULTS.minCollapseRows),
      }
    }

    // ---- shared style injection ------------------------------------------
    var STYLE_ID = 'dsh-response-window-css'
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
        '.drw-head {',
        '  display: flex; align-items: center; gap: 8px;',
        '  padding: 6px 10px;',
        '  cursor: pointer; user-select: none;',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  font-size: 12.5px; line-height: 1.4;',
        '  background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.10));',
        '}',
        '.drw-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); }',
        '.drw-head-icon { font-size: 13px; }',
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
        /* assistant text window */
        '.drw-md { position: relative; }',
        '.drw-md.drw-md-capped {',
        '  max-height: var(--drw-md-max, 17.5em);',
        '  overflow-y: auto;',
        '  overscroll-behavior: contain;',
        '  padding-bottom: 6px;',
        '}',
        '.drw-md.drw-md-capped::after {',
        '  content: ""; position: sticky; left: 0; right: 0; bottom: 0; display: block; height: 26px;',
        '  margin-top: -26px; pointer-events: none;',
        '  background: linear-gradient(transparent, var(--dsw-alias-bg-layer-1, #1c1c20));',
        '}',
        '.drw-md-btn {',
        '  position: sticky; bottom: 4px; display: inline-flex; align-items: center; gap: 4px;',
        '  margin: 2px 0 4px; z-index: 5;',
        '  font-size: 11.5px; cursor: pointer; user-select: none;',
        '  border: none; border-radius: 999px; padding: 2px 10px;',
        '  color: var(--dsw-alias-label-primary, #eee);',
        '  background: var(--dsw-specific-button-secondary, rgba(128,128,128,0.4));',
        '  white-space: nowrap;',
        '}',
        '.drw-md-btn:hover { background: var(--dsw-specific-button-secondary-hover, rgba(128,128,128,0.6)); }',
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

    // ---- the per-turn slide -------------------------------------------------
    function TurnSlide(props) {
      var nodes = props.nodes
      var turn = props.turn
      var cwd = props.cwd
      var openFile = props.openFile
      var inspectCall = props.inspectCall
      var cfg = props.config
      var stats = React.useMemo(function () {
        return computeStats(nodes.map(function (n) { return n.data.root }))
      }, [nodes])
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
      var list = nodes
      if (!cfg.showReadOnly) {
        list = nodes.filter(function (n) { return !READONLY_TOOLS.has(callName(n.data.root)) })
      }
      return React.createElement('div', { className: 'drw-slide', 'data-running': running ? '1' : undefined },
        React.createElement('div', {
          className: 'drw-head', role: 'button', tabIndex: 0,
          'aria-expanded': open || undefined,
          onClick: function () { setOpen(!open) },
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } },
        },
          React.createElement('span', { className: 'drw-head-icon', 'aria-hidden': true }, '\uD83D\uDD27'),
          React.createElement('span', { className: 'drw-head-title' },
            '响应 ' + turn + ' · ' + stats.total + ' 个工具调用'
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
          style: open && cfg.lines > 0 ? { maxHeight: (cfg.lines * 1.55) + 'em' } : undefined,
        },
          list.map(function (n) {
            return React.createElement(SimpleToolRow, {
              key: n.key,
              block: n.data.root,
              cwd: cwd,
              openFile: openFile,
              inspectCall: inspectCall,
            })
          }),
        ),
      )
    }

    // ---- slot component: one slide per turn, siblings render null ----------
    function ToolTurnSlide(props) {
      var node = props.node
      var useSession = props.useSession
      var cwd = props.cwd
      var openFile = props.openFile
      var inspectCall = props.inspectCall
      var turn = turnNumber(node)
      var EMPTY = []
      var nodes = useSession(function (snapshot) {
        if (turn === undefined || !snapshot || !snapshot.chat || !snapshot.chat.locations) return EMPTY
        var chat = snapshot.chat
        var order = chat.locations.getTurn(turn)
        var out = []
        for (var i = 0; i < order.length; i++) {
          var candidate = chat.nodes.get(order[i])
          if (candidate !== undefined && candidate.kind === 'tool-call') out.push(candidate)
        }
        return out
      })
      // Any error abdicates to the built-in renderer (safe fallback).
      try {
        if (!nodes || nodes.length === 0) return null
        if (node.key !== nodes[0].key) return null
        return React.createElement(TurnSlide, {
          nodes: nodes,
          turn: turn,
          cwd: cwd,
          openFile: openFile,
          inspectCall: inspectCall,
          config: currentConfig,
        })
      } catch (e) {
        return null
      }
    }

    // ---- assistant text window (class + CSS only, no reparenting) ----------
    function scanAssistantText(root, cfg) {
      if (!cfg.wrapAssistantText || cfg.lines <= 0) return
      var rows = root.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r]
        // Only settled blocks: skip blocks still streaming (avoid jitter while
        // the markdown grows; a later mutation re-runs the scan).
        if (row.closest('[data-streaming]')) continue
        var blocks = row.querySelectorAll('[class*="_markdown"]')
        for (var i = 0; i < blocks.length; i++) {
          var el = blocks[i]
          if (el.dataset.drwMd === '1') continue
          var maxH = cfg.lines * 1.75 + 1.5
          var full = el.scrollHeight
          if (!(full > maxH)) continue
          el.dataset.drwMd = '1'
          el.classList.add('drw-md', 'drw-md-capped')
          el.style.setProperty('--drw-md-max', maxH + 'em')
          var btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'drw-md-btn'
          btn.textContent = '展开全部 ▾'
          btn.addEventListener('click', function (e) {
            e.stopPropagation()
            e.preventDefault()
            var capped = el.classList.toggle('drw-md-capped')
            el.style.setProperty('--drw-md-max', capped ? maxH + 'em' : 'none')
            btn.textContent = capped ? '展开全部 ▾' : '收起 ▴'
          })
          el.appendChild(btn)
        }
      }
    }

    // Invisible per-session dock that watches the conversation scroller and
    // applies the assistant text window (session-scoped, disposed on switch).
    function TextWindowDock(props) {
      var mountRef = React.useRef(null)
      var cfgRef = React.useRef(currentConfig)
      React.useEffect(function () {
        var mount = mountRef.current
        if (!mount) return
        var scroller = mount.closest('[data-conversation-scroll]')
        var root = scroller || document.body
        var timer = null
        var scan = function () { try { scanAssistantText(root, cfgRef.current) } catch (e) {} }
        scan()
        var observer = new MutationObserver(function () {
          if (timer) return
          timer = setTimeout(function () { timer = null; scan() }, 220)
        })
        observer.observe(root, { childList: true, subtree: true })
        // Re-scan shortly after mount for already-settled history.
        var boot = setTimeout(scan, 600)
        return function () {
          observer.disconnect()
          if (timer) clearTimeout(timer)
          clearTimeout(boot)
        }
      }, [props.sessionId])
      return React.createElement('div', { ref: mountRef, 'data-drw-dock': '', style: { display: 'none' } })
    }

    // ---- plugin entry -------------------------------------------------------
    var currentConfig = readConfig(null)

    var INJECT = ['slots']
    function apply(ctx, config) {
      currentConfig = readConfig(config)
      injectStyles()
      ctx.slots.inject('conversation.chat.node', function () {
        return ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'tool-call',
          priority: -100,
          locale: 'conversation',
        }, ToolTurnSlide)
      })
      if (currentConfig.wrapAssistantText) {
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-response-window',
            order: 90,
          }, TextWindowDock)
        })
      }
    }

    exports.apply = apply
    exports.inject = INJECT
    Object.defineProperty(exports, '__esModule', { value: true })
    return module.exports
  },
})
