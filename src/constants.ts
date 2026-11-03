/** Stable identifier used by both the v1 and the v2 entrypoint. */
export const PLUGIN_ID = "opencode-auto-compact";

/**
 * Fixed context threshold, in tokens.
 *
 * This value is a product requirement and is intentionally a compile-time
 * constant. It is never read from plugin options, environment variables or a
 * config file, so no caller can change when compaction happens.
 */
export const COMPACT_THRESHOLD_TOKENS = 200_000;

/** Merge window for the two idle signals (`session.idle`, `session.status`). */
export const IDLE_DEBOUNCE_MS = 2_000;

/** Minimum gap between two compaction attempts for the same session. */
export const ATTEMPT_COOLDOWN_MS = 60_000;

/** Gap kept after a successful compaction before another attempt is allowed. */
export const SUCCESS_COOLDOWN_MS = 60_000;

/** Gap kept after a failed compaction before another attempt is allowed. */
export const FAILURE_COOLDOWN_MS = 60_000;

/** Delay before the startup sweep, so the host finishes loading the session. */
export const STARTUP_SWEEP_DELAY_MS = 1_000;
