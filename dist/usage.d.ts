/**
 * Token accounting for a session.
 *
 * The effective context size of the latest assistant turn is the prompt it was
 * given: uncached input tokens plus cached prompt tokens. Output tokens are not
 * part of the prompt that was sent, so they are excluded.
 */
export interface TokenSnapshot {
    /** Input plus cache-read tokens of the latest assistant message. */
    readonly effectiveTokens: number;
    readonly providerID: string;
    readonly modelID: string;
}
/** Unwrap the SDK response shape `T | { data: T }` used across host versions. */
export declare function unwrap<T>(value: unknown): T | undefined;
/** Read the effective prompt size of one message, or null when not assistant. */
export declare function readMessageTokens(entry: unknown): number | null;
/**
 * Walk messages backwards and return the newest assistant token snapshot.
 * Returns null when the session has no assistant message with token data.
 */
export declare function selectLatestSnapshot(messages: unknown): TokenSnapshot | null;
//# sourceMappingURL=usage.d.ts.map