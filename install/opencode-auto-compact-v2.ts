// OpenCode v2 discovery entry. install.sh copies this file to
// <config>/plugins/opencode-auto-compact.ts. The shared library stays in the
// v1 plugin directory so only one copy is installed.
//
// Both host generations read the default export and nothing else:
//
// - opencode 2.x requires a definition object and reads `id` / `setup`.
// - opencode 1.x calls `server(input)` on that same object.
//
// The shared library already exports one object carrying `id`, `setup` and
// `server`, so this entry re-exports it unchanged instead of wrapping it in a
// function. A function default export fails the v2 contract with
// `SchemaError(Expected object at ["default"])`.
import hybrid from "../plugin/opencode-auto-compact/index.js";

export default hybrid;
