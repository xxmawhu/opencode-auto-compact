/**
 * Diagnostic log sink for hosts that expose no log service.
 *
 * opencode 1.x hands plugins a log service (`app.log`). opencode 2.x does not:
 * the plugin context carries no log member, and lines written to stderr never
 * reach the host log file. Without a file sink the plugin is unobservable — an
 * inactive plugin and a correctly running one look identical, which is what hid
 * the first v2 regression.
 *
 * The sink writes `$XDG_STATE_HOME/opencode-auto-compact/auto-compact.log`
 * (default `~/.local/state/opencode-auto-compact/auto-compact.log`), rotating
 * to `.1` at 2 MiB. That is per-user state: never a project directory, a shared
 * data directory or a temporary directory.
 *
 * Invariant: logging never throws and never blocks session handling. When the
 * file cannot be opened, the line degrades to stderr.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PLUGIN_ID } from "./constants.js";
import type { LogLevel, RuntimeLogger } from "./runtime.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function logRoot(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, PLUGIN_ID);
}

function rotate(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // Rotation is best effort; the new line is still appended.
  }
}

function format(level: LogLevel, message: string, extra?: Record<string, unknown>): string {
  return `${JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: PLUGIN_ID,
    message,
    ...(extra === undefined ? {} : { extra }),
  })}\n`;
}

/** Create the file-backed logger. `root` is injectable so tests use a sandbox. */
export function createFileLogger(root: string = logRoot()): RuntimeLogger {
  const file = join(root, "auto-compact.log");

  return {
    log(level, message, extra): void {
      try {
        const line = format(level, message, extra);
        mkdirSync(root, { recursive: true, mode: 0o755 });
        rotate(file);
        appendFileSync(file, line, { mode: 0o644 });
        return;
      } catch {
        // A read-only home or an unserialisable payload must not break session
        // handling; fall through to stderr.
      }

      try {
        process.stderr.write(`[${PLUGIN_ID}] ${level} ${message}\n`);
      } catch {
        // Logging must never affect session handling.
      }
    },
  };
}
