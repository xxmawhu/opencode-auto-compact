/**
 * Token accounting for a session.
 *
 * The effective context size of the latest assistant turn is the prompt it was
 * given: uncached input tokens plus cached prompt tokens. Output tokens are not
 * part of the prompt that was sent, so they are excluded.
 */
function toCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return 0;
    return value;
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
    if (!entry || typeof entry !== "object")
        return null;
    const info = entry.info;
    if (!info || info.role !== "assistant" || !info.tokens)
        return null;
    const input = toCount(info.tokens.input);
    const cacheRead = toCount(info.tokens.cache?.read);
    const total = input + cacheRead;
    return total > 0 ? total : null;
}
/**
 * Walk messages backwards and return the newest assistant token snapshot.
 * Returns null when the session has no assistant message with token data.
 */
export function selectLatestSnapshot(messages) {
    const list = unwrap(messages);
    if (!Array.isArray(list))
        return null;
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        if (!entry || typeof entry !== "object")
            continue;
        const info = entry.info;
        if (!info || info.role !== "assistant" || !info.tokens)
            continue;
        const effectiveTokens = readMessageTokens(entry);
        if (effectiveTokens === null)
            continue;
        return {
            effectiveTokens,
            providerID: typeof info.providerID === "string" ? info.providerID : "",
            modelID: typeof info.modelID === "string" ? info.modelID : "",
        };
    }
    return null;
}
//# sourceMappingURL=usage.js.map