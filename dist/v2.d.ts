import { type LogLevel } from "./runtime.js";
/**
 * Minimal structural view of the v2 session namespace. The exact verb names
 * differ between v2 hosts, so each capability is probed at call time and the
 * runtime degrades to "no action" instead of throwing when one is missing.
 */
export interface V2Session {
    messages?(input: unknown): Promise<unknown>;
    summarize?(input: unknown): Promise<unknown>;
    compact?(input: unknown): Promise<unknown>;
    status?(input?: unknown): Promise<unknown>;
    list?(input?: unknown): Promise<unknown>;
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
export interface V2Context {
    client?: {
        session?: V2Session;
        app?: V2App;
    };
    session?: V2Session;
    app?: V2App;
    directory?: string;
    event?: {
        subscribe?(options: {
            types: string[];
            signal: AbortSignal;
        }): AsyncIterable<unknown> | undefined;
    };
}
/**
 * v2 server part. Subscribes to idle events and resolves to the cleanup
 * function expected by the v2 plugin contract.
 */
export declare function setupV2(ctx: V2Context | undefined): Promise<() => void>;
//# sourceMappingURL=v2.d.ts.map