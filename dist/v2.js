import { PLUGIN_ID } from "./constants.js";
import { claimActivation } from "./registry.js";
import { createRuntime } from "./runtime.js";
import { selectLatestSnapshot, unwrap } from "./usage.js";
function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const record = raw;
    const properties = record.properties ?? record.data;
    const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
    const statusType = properties?.status && typeof properties.status.type === "string"
        ? properties.status.type
        : undefined;
    return {
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(properties
            ? {
                properties: {
                    ...(sessionID === undefined ? {} : { sessionID }),
                    ...(statusType === undefined ? {} : { status: { type: statusType } }),
                },
            }
            : {}),
    };
}
function createLogger(app) {
    return {
        log(level, message, extra) {
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
function buildOps(session, directory) {
    const scoped = (extra = {}) => directory ? { ...extra, query: { directory } } : extra;
    async function readSnapshot(sessionID) {
        if (typeof session.messages !== "function")
            return null;
        let response;
        try {
            response = await session.messages({ path: { id: sessionID }, ...scoped() });
        }
        catch {
            // Older v2 hosts take a flat argument object.
            response = await session.messages({ sessionID });
        }
        return selectLatestSnapshot(response);
    }
    async function compact(sessionID, snapshot) {
        if (typeof session.summarize === "function") {
            await session.summarize({
                path: { id: sessionID },
                body: { providerID: snapshot.providerID, modelID: snapshot.modelID },
                ...scoped(),
            });
            return;
        }
        if (typeof session.compact === "function") {
            await session.compact({
                sessionID,
                providerID: snapshot.providerID,
                modelID: snapshot.modelID,
            });
            return;
        }
        throw new Error("host session does not expose summarize() or compact()");
    }
    async function listIdleSessions() {
        if (typeof session.status !== "function" || typeof session.list !== "function")
            return [];
        const statuses = unwrap(await session.status());
        if (!statuses || typeof statuses !== "object")
            return [];
        const sessions = unwrap(await session.list({ query: { directory } }));
        if (!Array.isArray(sessions))
            return [];
        const ids = [];
        for (const item of sessions) {
            const id = item?.id;
            if (typeof id === "string" && statuses[id]?.type === "idle")
                ids.push(id);
        }
        return ids;
    }
    return { readSnapshot, compact, listIdleSessions };
}
/**
 * v2 server part. Subscribes to idle events and resolves to the cleanup
 * function expected by the v2 plugin contract.
 */
export function setupV2(ctx) {
    const session = ctx?.client?.session ?? ctx?.session;
    const logger = createLogger(ctx?.client?.app ?? ctx?.app);
    if (!session) {
        logger.log("error", "v2 context has no session namespace");
        return Promise.resolve(() => { });
    }
    // Stay inert when the v1 entry already owns the process-wide runtime.
    const activation = claimActivation();
    if (!activation)
        return Promise.resolve(() => { });
    const runtime = createRuntime({ ops: buildOps(session, ctx?.directory), logger });
    const controller = new AbortController();
    const events = ctx?.event;
    if (typeof events?.subscribe === "function") {
        const stream = events.subscribe({
            types: ["session.idle", "session.status"],
            signal: controller.signal,
        });
        if (stream) {
            void (async () => {
                try {
                    for await (const raw of stream) {
                        await runtime.onEvent(normalizeEvent(raw));
                    }
                }
                catch (error) {
                    if (!controller.signal.aborted) {
                        logger.log("error", "idle event subscription failed", {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            })();
        }
    }
    else {
        // WARN (downgraded from error): the plugin cannot observe idle transitions
        // on this host build, so it does nothing instead of failing the session.
        logger.log("warn", "v2 context has no event.subscribe(); auto compaction is inactive");
    }
    runtime.start();
    return Promise.resolve(() => {
        controller.abort();
        runtime.stop();
        activation.release();
    });
}
//# sourceMappingURL=v2.js.map