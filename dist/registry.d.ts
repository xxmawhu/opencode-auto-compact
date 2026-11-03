/**
 * Process-wide activation guard.
 *
 * OpenCode discovers local plugins in both `plugin/` (classic entries) and
 * `plugins/` (v2 entries). A host that scans both directories loads this
 * library twice, which would create two runtimes, two idle subscriptions and
 * two summarize calls per idle session.
 *
 * The claim lives on `globalThis` rather than in a module-level variable so it
 * also covers the case where the two entries resolve to different module
 * instances.
 *
 * Invariant: at most one activation is held per process. A released activation
 * can be claimed again, which keeps the v1 `dispose()` / v2 cleanup paths
 * idempotent.
 */
export interface Activation {
    /** Release the claim; safe to call more than once. */
    release(): void;
}
/**
 * Claim the single runtime slot. Returns null when another entry already owns
 * it, in which case the caller must stay inert.
 */
export declare function claimActivation(): Activation | null;
//# sourceMappingURL=registry.d.ts.map