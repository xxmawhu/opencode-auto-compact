import { type LogLevel } from "./runtime.js";
/** Minimal structural view of the OpenCode v1 client handed to plugins. */
export interface V1Client {
    session?: {
        messages?(input: unknown): Promise<unknown>;
        summarize?(input: unknown): Promise<unknown>;
        status?(input?: unknown): Promise<unknown>;
        list?(input?: unknown): Promise<unknown>;
    };
    app?: {
        log?(input: {
            body: {
                service: string;
                level: LogLevel;
                message: string;
                extra?: Record<string, unknown>;
            };
        }): Promise<unknown>;
    };
}
export interface V1PluginInput {
    client?: V1Client;
    directory?: string;
    worktree?: string;
}
export interface PluginHooks {
    event(input: {
        event: unknown;
    }): Promise<void>;
    dispose?(): Promise<void>;
}
/** Build the classic v1 hook map. Returns `{}` when the host context is unusable. */
export declare function createV1Hooks(input: V1PluginInput | undefined): PluginHooks;
//# sourceMappingURL=v1.d.ts.map