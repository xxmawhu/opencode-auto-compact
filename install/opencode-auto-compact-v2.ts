// OpenCode v2 discovery entry. install.sh copies this file to
// <config>/plugins/opencode-auto-compact.ts. The shared library stays in the
// v1 plugin directory so only one copy is installed.
//
// Hosts that still call the default export as a classic plugin function get
// the v1 hook map. Hosts that read `id` / `setup` get the v2 server part.
import hybrid from "../plugin/opencode-auto-compact/index.js";

const createPlugin = (input) => {
  if (input && input.client && input.client.session) return hybrid.server(input);
  return {};
};

createPlugin.id = hybrid.id;
createPlugin.setup = (ctx) => hybrid.setup(ctx);

export const Plugin = createPlugin;
export default createPlugin;
