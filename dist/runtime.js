import { ATTEMPT_COOLDOWN_MS, COMPACT_THRESHOLD_TOKENS, FAILURE_COOLDOWN_MS, IDLE_DEBOUNCE_MS, STARTUP_SWEEP_DELAY_MS, SUCCESS_COOLDOWN_MS, } from "./constants.js";
/**
 * Event types that mean "the turn finished, the session is no longer working".
 *
 * opencode 2.3.2 does not publish `session.idle` for a finished turn: a probe of
 * a complete turn on the real host received `session.execution.started`,
 * `session.step.ended` and `session.execution.succeeded`, and no idle event at
 * all (2026-11-18, `.var` event probe). Subscribing to the idle names alone is
 * therefore a permanent no-op on 2.x, so the execution terminal events are the
 * idle signal there. The idle names stay in the set for hosts that do emit them.
 */
const TURN_FINISHED_TYPES = new Set([
    "session.idle",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
]);
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
export function createRuntime(deps) {
    const now = deps.now ?? Date.now;
    const sessions = new Map();
    const inFlight = new Set();
    let sweepTimer;
    function stateOf(sessionID) {
        const existing = sessions.get(sessionID);
        if (existing)
            return existing;
        const created = {
            lastCheckAt: 0,
            lastAttemptAt: 0,
            lastSuccessAt: 0,
            lastFailureAt: 0,
        };
        sessions.set(sessionID, created);
        return created;
    }
    function noteSuppression(sessionID, reason) {
        // INFO: one line per skipped turn-end signal. opencode publishes more than
        // one signal for a single finished turn, so this line is what separates
        // "the gate dropped it" from "the event stream delivered nothing at all" —
        // the distinction the first v2 regression left invisible.
        deps.logger.log("info", "turn-end signal suppressed", { sessionID, reason });
    }
    /**
     * Evaluate one idle session and compact it only when the fixed threshold is
     * exceeded. Returns the compacted flag for tests and the startup sweep.
     */
    async function evaluate(sessionID) {
        const current = now();
        const state = stateOf(sessionID);
        // Every turn-end signal for the same turn describes one idle transition.
        if (current - state.lastCheckAt < IDLE_DEBOUNCE_MS) {
            noteSuppression(sessionID, "debounce");
            return false;
        }
        state.lastCheckAt = current;
        if (inFlight.has(sessionID)) {
            noteSuppression(sessionID, "in-flight");
            return false;
        }
        if (current - state.lastAttemptAt < ATTEMPT_COOLDOWN_MS) {
            noteSuppression(sessionID, "attempt-cooldown");
            return false;
        }
        if (current - state.lastSuccessAt < SUCCESS_COOLDOWN_MS) {
            noteSuppression(sessionID, "success-cooldown");
            return false;
        }
        if (current - state.lastFailureAt < FAILURE_COOLDOWN_MS) {
            noteSuppression(sessionID, "failure-cooldown");
            return false;
        }
        inFlight.add(sessionID);
        try {
            const snapshot = await deps.ops.readSnapshot(sessionID);
            // INFO: one line per idle evaluation. Without it the host log cannot
            // distinguish "plugin inactive" from "session still under the fixed
            // threshold", which is what made the first v2 regression invisible.
            deps.logger.log("info", "idle session evaluated against the fixed threshold", {
                sessionID,
                effectiveTokens: snapshot?.effectiveTokens ?? null,
                thresholdTokens: COMPACT_THRESHOLD_TOKENS,
            });
            if (!snapshot || snapshot.effectiveTokens <= COMPACT_THRESHOLD_TOKENS) {
                return false;
            }
            if (!snapshot.providerID || !snapshot.modelID) {
                // [log-review] warn downgraded from error: (1) older hosts may omit model
                // metadata, an expected message shape; (2) the next idle turn retries, so
                // nothing is lost and error would only add noise; (3) triggers when a
                // session is over the fixed threshold and its latest message has no
                // model, impact is one deferred compaction.
                deps.logger.log("warn", "session is over the compact threshold but the model is unknown", {
                    sessionID,
                    effectiveTokens: snapshot.effectiveTokens,
                });
                return false;
            }
            state.lastAttemptAt = now();
            await deps.ops.compact(sessionID, snapshot);
            state.lastSuccessAt = now();
            deps.logger.log("info", "compacted an idle session over the fixed threshold", {
                sessionID,
                effectiveTokens: snapshot.effectiveTokens,
                thresholdTokens: COMPACT_THRESHOLD_TOKENS,
            });
            return true;
        }
        catch (error) {
            state.lastFailureAt = now();
            deps.logger.log("error", "auto compaction failed", {
                sessionID,
                error: describeError(error),
            });
            return false;
        }
        finally {
            inFlight.delete(sessionID);
        }
    }
    async function onEvent(event) {
        try {
            const type = event?.type;
            if (type === "session.deleted") {
                const deleted = event.properties?.sessionID;
                if (deleted)
                    sessions.delete(deleted);
                return;
            }
            const isIdle = (typeof type === "string" && TURN_FINISHED_TYPES.has(type)) ||
                (type === "session.status" && event.properties?.status?.type === "idle");
            if (!isIdle)
                return;
            const sessionID = event.properties?.sessionID;
            if (!sessionID)
                return;
            await evaluate(sessionID);
        }
        catch (error) {
            // Hooks must never throw into the host.
            deps.logger.log("error", "event handling failed", { error: describeError(error) });
        }
    }
    async function sweep() {
        try {
            const idle = await deps.ops.listIdleSessions?.();
            if (!Array.isArray(idle))
                return;
            for (const sessionID of idle) {
                if (typeof sessionID === "string" && sessionID.length > 0) {
                    await evaluate(sessionID);
                }
            }
        }
        catch (error) {
            // [log-review] warn downgraded from error: (1) a host without a session
            // listing is a supported configuration; (2) the sweep is best-effort and
            // live idle events still drive compaction, so error would be misleading;
            // (3) triggers only on hosts whose listing call throws, impact is no
            // startup sweep for already-idle sessions.
            deps.logger.log("warn", "startup idle sweep deferred: host session listing unavailable", {
                error: describeError(error),
            });
        }
    }
    function start() {
        if (sweepTimer || typeof deps.ops.listIdleSessions !== "function")
            return;
        sweepTimer = setTimeout(() => {
            sweepTimer = undefined;
            void sweep();
        }, STARTUP_SWEEP_DELAY_MS);
        const timer = sweepTimer;
        // Do not keep the host process alive just for the sweep.
        if (timer && typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
    }
    function stop() {
        if (!sweepTimer)
            return;
        clearTimeout(sweepTimer);
        sweepTimer = undefined;
    }
    return { onEvent, sweep, start, stop };
}
//# sourceMappingURL=runtime.js.map