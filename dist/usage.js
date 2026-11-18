/**
 * Token accounting for a session.
 *
 * The effective context size of the latest assistant turn is the prompt it was
 * given: uncached input tokens plus cached prompt tokens. Output tokens are not
 * part of the prompt that was sent, so they are excluded.
 *
 * Two host generations report the same numbers in different shapes:
 *   - opencode 1.x wraps the message in `info` and names the model fields
 *     `info.providerID` / `info.modelID`.
 *   - opencode 2.x returns flat messages, keyed by `type` and carrying
 *     `model.id` / `model.providerID` (verified against opencode 2.3.2).
 */
function toCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return 0;
    return value;
}
/** Prompt size of one message: uncached input plus cached prompt tokens. */
function promptTokens(tokens) {
    return toCount(tokens.input) + toCount(tokens.cache?.read);
}
/** Read the token snapshot of one message, or null when it is not an assistant turn. */
function snapshotOf(entry) {
    if (!entry || typeof entry !== "object")
        return null;
    const record = entry;
    const info = record.info;
    if (info) {
        if (info.role !== "assistant" || !info.tokens)
            return null;
        const effectiveTokens = promptTokens(info.tokens);
        if (effectiveTokens <= 0)
            return null;
        return {
            effectiveTokens,
            providerID: typeof info.providerID === "string" ? info.providerID : "",
            modelID: typeof info.modelID === "string" ? info.modelID : "",
        };
    }
    if (record.type !== "assistant" || !record.tokens)
        return null;
    const effectiveTokens = promptTokens(record.tokens);
    if (effectiveTokens <= 0)
        return null;
    const model = record.model;
    return {
        effectiveTokens,
        providerID: typeof model?.providerID === "string" ? model.providerID : "",
        modelID: typeof model?.id === "string" ? model.id : "",
    };
}
/** Unwrap the SDK response shape `T | { data: T }` used across host versions. */
export function unwrap(value) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === "object" && "data" in value) {
        return value.data;
    }
    return value;
}
/** Read the effective prompt size of one message, or null when not assistant. */
export function readMessageTokens(entry) {
    return snapshotOf(entry)?.effectiveTokens ?? null;
}
/**
 * Walk messages backwards and return the newest assistant token snapshot.
 * Returns null when the session has no assistant message with token data; the
 * turn that is still streaming carries no tokens yet and is skipped.
 */
export function selectLatestSnapshot(messages) {
    const list = unwrap(messages);
    if (!Array.isArray(list))
        return null;
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const snapshot = snapshotOf(list[index]);
        if (snapshot)
            return snapshot;
    }
    return null;
}
//# sourceMappingURL=usage.js.map