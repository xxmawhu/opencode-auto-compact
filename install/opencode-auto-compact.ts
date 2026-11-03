// OpenCode v1 legacy local plugin entry. install.sh copies this file to
// <config>/plugin/opencode-auto-compact.ts next to the built library directory
// <config>/plugin/opencode-auto-compact/.
//
// The v1 loader treats every export of a local plugin module as a plugin
// function, so this file exports functions only. Older v1 hosts call the
// default export with the classic plugin input.
import hybrid from "./opencode-auto-compact/index.js";

const createPlugin = (input) => hybrid.server(input);

export const Plugin = createPlugin;
export default createPlugin;
