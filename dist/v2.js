import { PLUGIN_ID } from "./constants.js";
import { createFileLogger } from "./log.js";
import { claimActivation } from "./registry.js";
import { createRuntime } from "./runtime.js";
import { selectLatestSnapshot } from "./usage.js";
/**
 * Reduce a host event to the runtime's event shape. 1.x payloads live under
 * `properties`; 2.x publishes the same fields under `data`.
 */
function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const record = raw;
    const payload = record.properties ?? record.data;
    const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : undefined;
    const statusType = payload?.status && typeof payload.status.type === "string" ? payload.status.type : undefined;
    return {
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(payload
            ? {
                properties: {
                    ...(sessionID === undefined ? {} : { sessionID }),
                    ...(statusType === undefined ? {} : { status: { type: statusType } }),
                },
            }
            : {}),
    };
}
/**
 * opencode 2.x exposes no log endpoint: `ctx.app` is `{ channel, name, version }`
 * (verified against 2.3.2) and plugin stderr never reaches the host log file.
 * The runtime therefore records its own JSON lines through the file sink; when
 * a host does offer `app.log`, that channel is preferred.
 */
function createLogger(app) {
    const fileLogger = createFileLogger();
    return {
        log(level, message, extra) {
            if (typeof app?.log === "function") {
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
                return;
            }
            fileLogger.log(level, message, extra);
        },
    };
}
function buildOps(session) {
    return {
        async readSnapshot(sessionID) {
            if (typeof session.context !== "function")
                return null;
            return selectLatestSnapshot(await session.context({ sessionID }));
        },
        async compact(sessionID) {
            if (typeof session.compact !== "function") {
                throw new Error("host session does not expose compact()");
            }
            // 2.x derives the summarization model from the session and schedules the
            // compaction for the next step boundary, so only the id is needed.
            await session.compact({ sessionID });
        },
        // No startup sweep: 2.x has no per-session status map. Finished turns
        // arrive as `session.execution.*` terminal events (2.3.2 does not emit
        // `session.idle`), which the runtime treats as idle transitions.
    };
}
/**
 * v2 server part. Subscribes to idle events and resolves to the cleanup
 * function expected by the v2 plugin contract.
 */
export function setupV2(ctx) {
    const session = ctx?.session;
    const logger = createLogger(ctx?.app);
    if (!session) {
        // INFO: design-internal degradation. A host without a session namespace
        // simply runs without auto compaction; this is not an operational fault.
        logger.log("info", "no session namespace in the plugin context; auto compaction stays inactive");
        return Promise.resolve(() => { });
    }
    // Stay inert when the v1 entry already owns the process-wide runtime.
    const activation = claimActivation();
    if (!activation)
        return Promise.resolve(() => { });
    logger.log("info", "auto-compact runtime activated", { entry: "v2" });
    const runtime = createRuntime({ ops: buildOps(session), logger });
    const controller = new AbortController();
    const events = ctx?.event;
    const stream = typeof events?.subscribe === "function"
        ? events.subscribe({
            types: [
                "session.idle",
                "session.status",
                "session.execution.succeeded",
                "session.execution.failed",
                "session.execution.interrupted",
                "session.deleted",
            ],
            signal: controller.signal,
        })
        : undefined;
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
    else {
        // INFO: design-internal degradation. This host build exposes no
        // event.subscribe, so the plugin cannot observe idle transitions and does
        // nothing instead of interrupting the session.
        logger.log("info", "event.subscribe is unavailable; auto compaction stays inactive");
    }
    return Promise.resolve(() => {
        controller.abort();
        runtime.stop();
        activation.release();
    });
}
//# sourceMappingURL=v2.js.map