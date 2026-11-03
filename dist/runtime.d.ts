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
        status?: {
            type?: string;
        };
    };
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
export declare function createRuntime(deps: RuntimeDeps): AutoCompactRuntime;
//# sourceMappingURL=runtime.d.ts.map