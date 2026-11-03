import {
  ATTEMPT_COOLDOWN_MS,
  COMPACT_THRESHOLD_TOKENS,
  FAILURE_COOLDOWN_MS,
  IDLE_DEBOUNCE_MS,
  STARTUP_SWEEP_DELAY_MS,
  SUCCESS_COOLDOWN_MS,
} from "./constants.js";
import type { TokenSnapshot } from "./usage.js";

export type LogLevel = "info" | "warn" | "error";

export interface RuntimeLogger {
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
}

/** Host capabilities the runtime needs, isolated so tests can stub them. */
export interface CompactOps {
  /** Latest assistant token snapshot for a session, or null when unknown. */
  readSnapshot(sessionID: string): Promise<TokenSnapshot | null>;
  /** Ask the host to compact the session. Rejects on failure. */
  compact(sessionID: string, snapshot: TokenSnapshot): Promise<void>;
  /** Sessions that are currently idle in this directory (startup sweep). */
  listIdleSessions?(): Promise<string[]>;
}

export interface IdleEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    status?: { type?: string };
  };
}

interface SessionState {
  lastCheckAt: number;
  lastAttemptAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
}

export interface RuntimeDeps {
  readonly ops: CompactOps;
  readonly logger: RuntimeLogger;
  readonly now?: () => number;
}

export interface AutoCompactRuntime {
  /** Feed one host event into the runtime. Never throws. */
  onEvent(event: IdleEvent): Promise<void>;
  /** Evaluate every session the host reports as idle. Never throws. */
  sweep(): Promise<void>;
  /** Schedule the one-shot startup sweep for sessions already idle. */
  start(): void;
  /** Cancel the startup sweep. */
  stop(): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRuntime(deps: RuntimeDeps): AutoCompactRuntime {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, SessionState>();
  const inFlight = new Set<string>();
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  function stateOf(sessionID: string): SessionState {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const created: SessionState = {
      lastCheckAt: 0,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
    };
    sessions.set(sessionID, created);
    return created;
  }

  /**
   * Evaluate one idle session and compact it only when the fixed threshold is
   * exceeded. Returns the compacted flag for tests and the startup sweep.
   */
  async function evaluate(sessionID: string): Promise<boolean> {
    const current = now();
    const state = stateOf(sessionID);

    // `session.idle` and `session.status(idle)` describe the same transition.
    if (current - state.lastCheckAt < IDLE_DEBOUNCE_MS) return false;
    state.lastCheckAt = current;

    if (inFlight.has(sessionID)) return false;
    if (current - state.lastAttemptAt < ATTEMPT_COOLDOWN_MS) return false;
    if (current - state.lastSuccessAt < SUCCESS_COOLDOWN_MS) return false;
    if (current - state.lastFailureAt < FAILURE_COOLDOWN_MS) return false;

    inFlight.add(sessionID);
    try {
      const snapshot = await deps.ops.readSnapshot(sessionID);
      if (!snapshot || snapshot.effectiveTokens <= COMPACT_THRESHOLD_TOKENS) {
        return false;
      }

      if (!snapshot.providerID || !snapshot.modelID) {
        // WARN (downgraded from error): old host messages may omit model
        // metadata; compaction waits for a later turn instead of failing hard.
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
    } catch (error) {
      state.lastFailureAt = now();
      deps.logger.log("error", "auto compaction failed", {
        sessionID,
        error: describeError(error),
      });
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  }

  async function onEvent(event: IdleEvent): Promise<void> {
    try {
      const type = event?.type;
      if (type === "session.deleted") {
        const deleted = event.properties?.sessionID;
        if (deleted) sessions.delete(deleted);
        return;
      }

      const isIdle =
        type === "session.idle" ||
        (type === "session.status" && event.properties?.status?.type === "idle");
      if (!isIdle) return;

      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      await evaluate(sessionID);
    } catch (error) {
      // Hooks must never throw into the host.
      deps.logger.log("error", "event handling failed", { error: describeError(error) });
    }
  }

  async function sweep(): Promise<void> {
    try {
      const idle = await deps.ops.listIdleSessions?.();
      if (!Array.isArray(idle)) return;
      for (const sessionID of idle) {
        if (typeof sessionID === "string" && sessionID.length > 0) {
          await evaluate(sessionID);
        }
      }
    } catch (error) {
      // WARN (downgraded from error): the sweep is best-effort; live idle
      // events still drive compaction.
      deps.logger.log("warn", "startup idle sweep failed", { error: describeError(error) });
    }
  }

  function start(): void {
    if (sweepTimer || typeof deps.ops.listIdleSessions !== "function") return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      void sweep();
    }, STARTUP_SWEEP_DELAY_MS);
    const timer = sweepTimer;
    // Do not keep the host process alive just for the sweep.
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  }

  function stop(): void {
    if (!sweepTimer) return;
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }

  return { onEvent, sweep, start, stop };
}
