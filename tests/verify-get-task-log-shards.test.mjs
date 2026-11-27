import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "verify-get-task-from-notion-502.sh");
const FIX_COMMIT = "b68e7b6"; // 2026-11-19T11:40:45Z, issues 2cfa1e52 / a29225ae
const HOUR_MS = 3600_000;
// Shards are spawned synchronously; the cap keeps a hung verifier from wedging
// the pre-commit hook that runs this suite.
const SPAWN_TIMEOUT_MS = 30_000;

// The target project rotates hourly (`task_YYYYMMDDTHH.log`). The verifier used
// to read a single `task_<day>.log`, so from the 2026-11-21 switch onwards it
// matched no file, reported "0 cycles", and could never pass. These tests pin
// the shard-collection contract so a future filename change fails loudly here
// instead of silently degrading the gate to INCONCLUSIVE forever.
function sandbox() {
  const root = mkdtempSync(join(ROOT, "tests", ".tmp-verify-502-"));
  const logDir = join(root, "target-log");
  const outDir = join(root, "out");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // The fix commit is resolved with git, so the fixture keeps the real target
  // repository (read-only) and only redirects where shards are read from.
  const source = readFileSync(SCRIPT, "utf8")
    .replace(/"\$TARGET\/log" "/, `"${logDir}" "`)
    .replace(/^LOG_DIR=.*$/m, `LOG_DIR=${outDir}`);
  const script = join(root, "verify.sh");
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  assert.ok(
    source.includes(`python3 - "${logDir}"`),
    "log dir override must apply, otherwise the test reads production logs",
  );
  return { root, logDir, outDir, script };
}

function stamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const clock = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return { date, clock, hour: `${date.replaceAll("-", "")}T${p(d.getUTCHours())}` };
}

function writeShard(logDir, prefix, epochMs, lines) {
  const { hour, date, clock } = stamp(epochMs);
  const body = lines.map((line) => `${date} ${clock}.000 +00:00 | ${line}\n`).join("");
  writeFileSync(join(logDir, `${prefix}_${hour}.log`), body);
}

// The script shells out to git for the fix date, so the fixture points it at a
// real commit inside this repository and shifts the log timestamps instead.
function runVerify({ script, logDir }, fixCommit) {
  const patched = join(logDir, "..", "verify-under-test.sh");
  writeFileSync(
    patched,
    readFileSync(script, "utf8").replace(/^FIX_COMMIT=.*$/m, `FIX_COMMIT=${fixCommit}`),
  );
  chmodSync(patched, 0o755);
  return spawnSync("bash", [patched], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
}

function verdict(stdout) {
  return /^verdict: (\S+)$/m.exec(stdout)?.[1];
}

function cycles(stdout) {
  return Number(/^cycles_after_fix: (\d+)$/m.exec(stdout)?.[1]);
}

// A verifier that crashed or was killed prints no verdict; asserting on the
// parsed value alone would throw an opaque "expected undefined" instead of
// naming the failure.
function assertRan(result) {
  assert.equal(
    result.status !== null && !result.error,
    true,
    `verify did not run: ${result.error ?? "timeout"}`,
  );
}

test("hourly shards after the fix count as cycles and pass with no signatures", () => {
  const box = sandbox();
  try {
    const base = Date.UTC(2026, 10, 26, 0, 0, 0);
    for (let hour = 0; hour < 4; hour += 1) {
      writeShard(box.logDir, "task", base + hour * HOUR_MS, ["INFO | run_cycle | page ok"]);
    }
    const result = runVerify(box, FIX_COMMIT);
    assertRan(result);
    assert.equal(verdict(result.stdout), "PASS", result.stdout);
    assert.ok(cycles(result.stdout) >= 3, result.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a signature inside the post-fix window fails even when shards exist", () => {
  const box = sandbox();
  try {
    const base = Date.UTC(2026, 10, 26, 0, 0, 0);
    writeShard(box.logDir, "task", base, ["INFO | run_cycle | page ok"]);
    writeShard(box.logDir, "task", base + HOUR_MS, ["INFO | run_cycle | page ok"]);
    writeShard(box.logDir, "task", base + 2 * HOUR_MS, ["INFO | run_cycle | page ok"]);
    writeShard(box.logDir, "error", base + 2 * HOUR_MS, [
      "ERROR | notion | status: 502 from upstream",
    ]);
    const result = runVerify(box, FIX_COMMIT);
    assertRan(result);
    assert.equal(verdict(result.stdout), "FAIL", result.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("no shards at all is INCONCLUSIVE, never PASS", () => {
  const box = sandbox();
  try {
    const result = runVerify(box, FIX_COMMIT);
    assertRan(result);
    assert.equal(verdict(result.stdout), "INCONCLUSIVE", result.stdout);
    assert.equal(cycles(result.stdout), 0, result.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("shards older than the fix day are excluded from the post-fix window", () => {
  const box = sandbox();
  try {
    // 2026-11-18 predates the 2026-11-19 fix: its 5xx must land in pre_*, not
    // drag the verdict to FAIL. Older files are still read so pre_* stays honest.
    writeShard(box.logDir, "error", Date.UTC(2026, 10, 18, 3, 0, 0), [
      "ERROR | notion | status: 500",
    ]);
    const base = Date.UTC(2026, 10, 26, 0, 0, 0);
    for (let hour = 0; hour < 3; hour += 1) {
      writeShard(box.logDir, "task", base + hour * HOUR_MS, ["INFO | run_cycle | page ok"]);
    }
    const result = runVerify(box, FIX_COMMIT);
    assertRan(result);
    assert.equal(verdict(result.stdout), "PASS", result.stdout);
    assert.match(result.stdout, /^pre_5xx: 1$/m, result.stdout);
    assert.match(result.stdout, /^after_5xx: 0$/m, result.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("loguru rotation leftovers are read, not treated as duplicates", () => {
  const box = sandbox();
  try {
    const base = Date.UTC(2026, 10, 26, 0, 0, 0);
    for (let hour = 0; hour < 3; hour += 1) {
      writeShard(box.logDir, "task", base + hour * HOUR_MS, ["INFO | run_cycle | page ok"]);
    }
    // `task_20261126T14.2026-11-26_14-18-28_000000.log` holds records written
    // just before the rollover; dropping it loses those cycles.
    const { date, clock } = stamp(base + 3 * HOUR_MS);
    writeFileSync(
      join(box.logDir, "task_20261126T14.2026-11-26_14-18-28_000000.log"),
      `${date} ${clock}.000 +00:00 | INFO     | __main__:run_cycle:716 - page ok\n`,
    );
    const result = runVerify(box, FIX_COMMIT);
    assertRan(result);
    assert.equal(verdict(result.stdout), "PASS", result.stdout);
    assert.ok(cycles(result.stdout) >= 3, result.stdout);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
