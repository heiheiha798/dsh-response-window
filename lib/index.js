// dsh-response-window — host half.
//
// Registers the durable settings namespace so the browser Settings UI can
// persist the window size etc. in the user settings document. The heavy lifting
// lives in the browser half (exports "./client").
//
// Namespace + schema (browser `settingsScope.bind` mirrors it):
//   lines             window height in lines (default 10; 0 = uncapped)
//   collapsed         start slides collapsed instead of always-expanded
//   showReadOnly      include read-only tools in the slide list
//   wrapAssistantText bounded scroll window on long assistant markdown
//   minCollapseRows   min tool-call count for auto-collapse (collapsed mode)
//
// `settingsNamespace()` is just a validated string (kebab-case pattern); the
// namespace below already matches, so we pass the raw string and avoid an extra
// host dependency.

import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'dsh-response-window'

/** Durable settings namespace for this plugin (lowercase kebab-case). */
export const SETTINGS_NS = 'dsh-response-window'

/** Settings schema, shared with the browser scope and any Settings UI. */
export const Config = z.object({
  lines: z.natural().min(0).max(200).default(10),
  collapsed: z.boolean().default(false),
  showReadOnly: z.boolean().default(true),
  wrapAssistantText: z.boolean().default(true),
  minCollapseRows: z.natural().min(1).max(50).default(3),
})

/**
 * Register the durable settings namespace when a settings provider exists.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NS, Config)
  })
}
