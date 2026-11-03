/**
 * Hybrid entrypoint shared by the v1 and v2 local plugin files.
 *
 * - v1 hosts load the default export and call `server(input)` for hooks.
 * - v2 hosts read `{ id, setup }` and call `setup(ctx)` once.
 *
 * The default export is required by the host loader, which is the one
 * sanctioned exception to the named-exports convention.
 */
import { PLUGIN_ID } from "./constants.js";
import { createV1Hooks, type PluginHooks, type V1PluginInput } from "./v1.js";
import { setupV2, type V2Context } from "./v2.js";

export interface HybridPlugin {
  readonly id: string;
  setup(ctx: V2Context | undefined): Promise<() => void>;
  server(input: V1PluginInput | undefined): Promise<PluginHooks>;
}

const plugin: HybridPlugin = {
  id: PLUGIN_ID,

  setup(ctx): Promise<() => void> {
    return setupV2(ctx);
  },

  server(input): Promise<PluginHooks> {
    return Promise.resolve(createV1Hooks(input));
  },
};

export default plugin;

export { PLUGIN_ID, COMPACT_THRESHOLD_TOKENS } from "./constants.js";
export type { PluginHooks, V1Client, V1PluginInput } from "./v1.js";
export type { V2Context } from "./v2.js";
