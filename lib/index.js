// dsh-response-window — host half.
//
// This plugin is entirely a browser rendering concern: the host half only
// carries stable identity so the profile loader mounts the row and serves the
// browser half (exports "./client"). Config normalization/validation happens
// defensively in the client half too (see lib/client.js readConfig), so this
// host stays dependency-free.
//
// Row config (fed by cordis.patch.yml):
//   lines             window height in lines (default 10; 0 = uncapped)
//   collapsed         start slides collapsed instead of always-expanded
//   showReadOnly      include read-only tools in the slide list
//   wrapAssistantText bounded scroll window on long assistant markdown
//   minCollapseRows   min tool-call count for auto-collapse (collapsed mode)

/** Stable Cordis plugin name. */
export const name = 'dsh-response-window'

/**
 * No host-side behavior is required — the feature lives in the browser half.
 * @param ctx - host plugin context (unused).
 */
export function apply(ctx) {
  void ctx
}
