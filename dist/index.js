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
import { createV1Hooks } from "./v1.js";
import { setupV2 } from "./v2.js";
const plugin = {
    id: PLUGIN_ID,
    setup(ctx) {
        return setupV2(ctx);
    },
    server(input) {
        return Promise.resolve(createV1Hooks(input));
    },
};
export default plugin;
export { PLUGIN_ID, COMPACT_THRESHOLD_TOKENS } from "./constants.js";
//# sourceMappingURL=index.js.map