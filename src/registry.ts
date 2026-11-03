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

const REGISTRY_KEY = Symbol.for("opencode-auto-compact.activation");

interface ActivationBag {
  active: boolean;
}

export interface Activation {
  /** Release the claim; safe to call more than once. */
  release(): void;
}

function bag(): ActivationBag {
  const holder = globalThis as unknown as Record<symbol, ActivationBag | undefined>;
  const existing = holder[REGISTRY_KEY];
  if (existing) return existing;
  const created: ActivationBag = { active: false };
  holder[REGISTRY_KEY] = created;
  return created;
}

/**
 * Claim the single runtime slot. Returns null when another entry already owns
 * it, in which case the caller must stay inert.
 */
export function claimActivation(): Activation | null {
  const current = bag();
  if (current.active) return null;
  current.active = true;

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      current.active = false;
    },
  };
}
