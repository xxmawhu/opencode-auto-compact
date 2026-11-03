import { type PluginHooks, type V1PluginInput } from "./v1.js";
import { type V2Context } from "./v2.js";
export interface HybridPlugin {
    readonly id: string;
    setup(ctx: V2Context | undefined): Promise<() => void>;
    server(input: V1PluginInput | undefined): Promise<PluginHooks>;
}
declare const plugin: HybridPlugin;
export default plugin;
export { PLUGIN_ID, COMPACT_THRESHOLD_TOKENS } from "./constants.js";
export type { PluginHooks, V1Client, V1PluginInput } from "./v1.js";
export type { V2Context } from "./v2.js";
//# sourceMappingURL=index.d.ts.map