import { PLUGIN_ID } from "./constants.js";
import { claimActivation } from "./registry.js";
import { createRuntime } from "./runtime.js";
import { selectLatestSnapshot, unwrap } from "./usage.js";
function createLogger(client) {
    return {
        log(level, message, extra) {
            const app = client?.app;
            if (typeof app?.log !== "function")
                return;
            void Promise.resolve(app.log({
                body: {
                    service: PLUGIN_ID,
                    level,
                    message,
                    ...(extra === undefined ? {} : { extra }),
                },
            })).catch(() => {
                // Logging must never affect session handling.
            });
        },
    };
}
function buildOps(client, directory) {
    const scoped = (extra = {}) => directory ? { ...extra, query: { directory } } : extra;
    return {
        async readSnapshot(sessionID) {
            const session = client.session;
            if (typeof session?.messages !== "function")
                return null;
            const response = await session.messages({
                path: { id: sessionID },
                ...scoped(),
            });
            return selectLatestSnapshot(response);
        },
        async compact(sessionID, snapshot) {
            const session = client.session;
            if (typeof session?.summarize !== "function") {
                throw new Error("host client does not expose session.summarize");
            }
            await session.summarize({
                path: { id: sessionID },
                body: { providerID: snapshot.providerID, modelID: snapshot.modelID },
                ...scoped(),
            });
        },
        async listIdleSessions() {
            const session = client.session;
            if (typeof session?.status !== "function" || typeof session.list !== "function")
                return [];
            const statuses = unwrap(await session.status());
            if (!statuses || typeof statuses !== "object")
                return [];
            const sessions = unwrap(await session.list({ query: { directory } }));
            if (!Array.isArray(sessions))
                return [];
            const ids = [];
            for (const session of sessions) {
                const id = session?.id;
                if (typeof id !== "string")
                    continue;
                if (statuses[id]?.type === "idle")
                    ids.push(id);
            }
            return ids;
        },
    };
}
/** Build the classic v1 hook map. Returns `{}` when the host context is unusable. */
export function createV1Hooks(input) {
    const client = input?.client;
    if (!client?.session)
        return {};
    // A host that scans both plugin directories loads this library twice; only
    // the first activation may own the runtime.
    const activation = claimActivation();
    if (!activation)
        return {};
    const directory = input?.directory ?? input?.worktree;
    const runtime = createRuntime({
        ops: buildOps(client, directory),
        logger: createLogger(client),
    });
    runtime.start();
    return {
        async event({ event }) {
            await runtime.onEvent(event);
        },
        dispose() {
            runtime.stop();
            activation.release();
            return Promise.resolve();
        },
    };
}
//# sourceMappingURL=v1.js.map