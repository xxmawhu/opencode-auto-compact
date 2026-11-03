/** Stable identifier used by both the v1 and the v2 entrypoint. */
export declare const PLUGIN_ID = "opencode-auto-compact";
/**
 * Fixed context threshold, in tokens.
 *
 * This value is a product requirement and is intentionally a compile-time
 * constant. It is never read from plugin options, environment variables or a
 * config file, so no caller can change when compaction happens.
 */
export declare const COMPACT_THRESHOLD_TOKENS = 200000;
/** Merge window for the two idle signals (`session.idle`, `session.status`). */
export declare const IDLE_DEBOUNCE_MS = 2000;
/** Minimum gap between two compaction attempts for the same session. */
export declare const ATTEMPT_COOLDOWN_MS = 60000;
/** Gap kept after a successful compaction before another attempt is allowed. */
export declare const SUCCESS_COOLDOWN_MS = 60000;
/** Gap kept after a failed compaction before another attempt is allowed. */
export declare const FAILURE_COOLDOWN_MS = 60000;
/** Delay before the startup sweep, so the host finishes loading the session. */
export declare const STARTUP_SWEEP_DELAY_MS = 1000;
//# sourceMappingURL=constants.d.ts.map