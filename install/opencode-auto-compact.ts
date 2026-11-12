// OpenCode v1 legacy local plugin entry. install.sh copies this file to
// <config>/plugin/opencode-auto-compact.ts next to the built library directory
// <config>/plugin/opencode-auto-compact/.
//
// Both host generations read the default export and nothing else:
//
// - opencode 1.x calls `server(input)` and uses the returned hook table.
// - opencode 2.x requires a definition object and reads `id` / `setup`.
//
// The shared library already exports one object carrying `id`, `setup` and
// `server`, so this entry re-exports it unchanged instead of wrapping it in a
// function. A function default export fails the v2 contract with
// `SchemaError(Expected object at ["default"])`.
//
// Keep this banner verbatim: install.sh copies this file into the host config,
// so changes here are visible after a pull-triggered install.
import hybrid from "./opencode-auto-compact/index.js";

export default hybrid;
