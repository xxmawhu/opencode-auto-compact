import { type LogLevel } from "./runtime.js";
/**
 * Structural view of the opencode 2.x plugin context.
 *
 * 2.x exposes the session namespace as `context` (stored messages), `compact`
 * (request compaction) and `list`. The 1.x-style members this file used to
 * probe — `messages`, `summarize`, `status` — do not exist there, which is why
 * the v2 entry stayed inert: every probe returned undefined and the runtime saw
 * "no token data" forever.
 */
export interface V2Session {
    context?(input: {
        sessionID: string;
    }): Promise<unknown>;
    compact?(input: {
        sessionID: string;
    }): Promise<unknown>;
}
export interface V2App {
    log?(input: {
        body: {
            service: string;
            level: LogLevel;
            message: string;
            extra?: Record<string, unknown>;
        };
    }): Promise<unknown>;
}
export interface V2EventStream {
    subscribe?(options: {
        types?: string[];
        signal?: AbortSignal;
    }): AsyncIterable<unknown>;
}
export interface V2Context {
    session?: V2Session;
    app?: V2App;
    event?: V2EventStream;
    location?: {
        directory?: string;
    };
    directory?: string;
}
/**
 * Host event names the plugin observes.
 *
 * `session.idle` is kept for hosts that publish it; opencode 2.3.2 reports a
 * finished turn through `session.execution.*` instead, and `session.status`
 * carries the idle flag on hosts that only publish status transitions.
 */
export declare const SUBSCRIBED_TYPES: string[];
/**
 * v2 server part. Subscribes to idle events and resolves to the cleanup
 * function expected by the v2 plugin contract.
 */
export declare function setupV2(ctx: V2Context | undefined): Promise<() => void>;
//# sourceMappingURL=v2.d.ts.map