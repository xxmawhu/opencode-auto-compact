/**
 * Process-wide activation guard.
 *
 * install.sh ships a single entry in `plugin/`, which both host generations
 * load exactly once. This guard is a defense layer, not the primary mechanism:
 * if the entry is ever copied into two scan locations, the host would evaluate
 * it twice, which would create two runtimes, two idle subscriptions and two
 * summarize calls per idle session. The claim stops the second activation.
 *
 * The claim lives on `globalThis` rather than in a module-level variable so it
 * also covers duplicate entries that resolve to different module instances.
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