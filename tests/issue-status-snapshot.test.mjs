// Regression test for the duplicate-digest defect in check-issue-status.sh.
//
// A closed issue is "changed" forever by definition (`status != doing`), so the
// script rewrote a byte-identical digest on every single run. Observed
// 2026-11-19: the 15:30 rerun reproduced the already-archived 14:22 digest with
// 29 rows and 0 differing rows, meaning issues/ could never stay clean and each
// rerun looked like a fresh status transition.
//
// The fix compares the non-doing snapshot with audit/issue-status-snapshot.txt
// and stays silent when nothing moved. This test drives the real script through
// its documented RAISE_OVERRIDE hook (TEST-suffixed artifacts only), so the
// assertion covers the shipping code path rather than a reimplementation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-issue-status.sh");
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const LOG = path.join(ROOT, "log", `issue-status-test.${stamp}.log`);
// TEST digests live under audit/, never issues/: a leftover in issues/ would be
// read by the triage loop as a real backlog item (2026-11-20).
const DIGEST = path.join(ROOT, "audit", `issue-status-change-TEST-${stamp}.md`);
const SNAPSHOT = path.join(ROOT, "audit", "issue-status-snapshot-TEST.txt");

function removeArtifacts() {
  for (const file of [LOG, DIGEST, SNAPSHOT]) {
    fs.rmSync(file, { force: true });
  }
}

function writeStubStable(dir) {
  // Every UUID id reports `done`, so the change set is non-empty and the first
  // run has a digest to publish; the second run must then see no movement.
  // The stub also records its working directory: raise-issue derives the caller
  // project from cwd, and a cron run without a cd was denied for every id
  // (STATUS DENIED: caller .../scripts). Each query must run from the project root.
  const stub = path.join(dir, "raise-issue");
  fs.writeFileSync(
    stub,
    [
      "#!/bin/bash",
      'printf "%s\\n" "$PWD" >> "$STATUS_CWD_LOG"',
      `printf 'issue_id:         %s\\nstatus:           done\\nreplied_at:       2026-11-19T00:00:00Z\\n' "$2"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return stub;
}

function runScript(stub, cwdLog) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, RAISE_OVERRIDE: stub, STATUS_CWD_LOG: cwdLog },
  });
}

test("an unchanged status snapshot publishes no second digest", () => {
  removeArtifacts();
  const tmp = fs.mkdtempSync(path.join(ROOT, "tests", ".tmp-issue-status-"));
  try {
    const stub = writeStubStable(tmp);
    const cwdLog = path.join(tmp, "stub-cwd.log");

    const first = runScript(stub, cwdLog);
    assert.equal(first.status, 0, first.stderr);
    const queriedFrom = fs.readFileSync(cwdLog, "utf8").trim().split("\n");
    assert.ok(queriedFrom.length > 0, "the stub records every status query");
    assert.deepEqual(
      [...new Set(queriedFrom)],
      [ROOT],
      "every status query runs from the project root (raise-issue caller identity)",
    );
    assert.ok(fs.existsSync(DIGEST), "first run publishes a digest");
    const digestBefore = fs.readFileSync(DIGEST, "utf8");
    assert.ok(digestBefore.length > 0);
    // The TEST digest must not point at the production log: naming the wrong
    // file makes a stubbed statuses table look like a real transition.
    assert.match(digestBefore, new RegExp(`issue-status-test\\.${stamp}\\.log`));
    assert.doesNotMatch(digestBefore, new RegExp(`issue-status\\.${stamp}\\.log`));
    const logBefore = fs.readFileSync(LOG, "utf8");

    const second = runScript(stub, cwdLog);
    assert.equal(second.status, 0, second.stderr);
    const added = fs.readFileSync(LOG, "utf8").slice(logBefore.length);
    assert.match(added, /OK issue status snapshot unchanged/);
    assert.doesNotMatch(added, /CHANGED /, "no new change record");
    assert.equal(
      fs.readFileSync(DIGEST, "utf8"),
      digestBefore,
      "digest is not rewritten when nothing moved",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    removeArtifacts();
  }
});

// Regression test for the daily self-audit error line
// `FAILED status unreachable for 1 of 63 issues: 4f646127-…` (2026-11-24).
//
// The ledger keeps forwarded issues: our project filed 8112bdcb and a forwarder
// copied it to hftapi/trade-rule-updater-2611 as 4f646127, so the record's
// sender is not this project. `raise-issue status` then answers "Permission
// denied: issue … is not related to caller project" — reproduced 3/3 by hand —
// while own issues answer normally. Counting that refusal as `unreachable`
// turned a permanent ownership fact into one error line on every cron run.
// The refusal must stay out of the change table and out of the error channel.
test("a forwarded issue the caller cannot read is skipped, not reported as unreachable", () => {
  removeArtifacts();
  const forwarded = "4f646127-9a0f-4bbf-9bdf-186649d4d960";
  const tmp = fs.mkdtempSync(path.join(ROOT, "tests", ".tmp-issue-status-unowned-"));
  try {
    const stub = path.join(tmp, "raise-issue");
    fs.writeFileSync(
      stub,
      [
        "#!/bin/bash",
        `if [[ "$2" == "${forwarded}" ]]; then`,
        '  printf "❌ status failed: Permission denied: issue %s is not related to caller project\\n" "$2" >&2',
        "  exit 1",
        "fi",
        `printf 'issue_id:         %s\\nstatus:           done\\nreplied_at:       2026-11-19T00:00:00Z\\n' "$2"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const run = runScript(stub, path.join(tmp, "stub-cwd.log"));
    assert.equal(run.status, 0, run.stderr);

    const log = fs.readFileSync(LOG, "utf8");
    assert.doesNotMatch(log, /\[error\]/, "ownership refusal is not an error");
    assert.match(
      log,
      new RegExp(`skipped 1 forwarded issue\\(s\\) not owned by caller: ${forwarded}`),
    );
    assert.match(log, new RegExp(`${forwarded} .* status=unowned`));
    assert.ok(fs.existsSync(DIGEST), "own issues still publish a digest");
    assert.doesNotMatch(fs.readFileSync(DIGEST, "utf8"), new RegExp(forwarded));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    removeArtifacts();
  }
});
// A TEST digest lists real ledger ids with fabricated statuses, so a leftover
// from an interrupted test would be read by triage as a real transition. The
// sweep runs before every audit; this test proves it removes the lookalikes and
// records what it touched.
test("leftover TEST artifacts are swept and named in the log", () => {
  const CLEANER = path.join(ROOT, "scripts", "cleanup-test-artifacts.sh");
  const CLEAN_LOG = path.join(ROOT, "log", `cleanup-test-artifacts.${stamp}.log`);
  const fakeDigest = path.join(ROOT, "issues", "issue-status-change-TEST-99999999.md");
  const fakeSnapshot = path.join(ROOT, "audit", "issue-status-snapshot-TEST.txt");

  fs.writeFileSync(fakeDigest, "# issue 状态变化 99999999\n");
  fs.writeFileSync(fakeSnapshot, "| stale |\n");
  try {
    const first = spawnSync("bash", [CLEANER], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.existsSync(fakeDigest), false, "digest removed");
    assert.equal(fs.existsSync(fakeSnapshot), false, "snapshot removed");
    assert.match(
      fs.readFileSync(CLEAN_LOG, "utf8"),
      /remove 2 leftover TEST artifacts .*issue-status-change-TEST-99999999\.md/,
    );

    // Second run has nothing to sweep and must still succeed.
    const second = spawnSync("bash", [CLEANER], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(fs.readFileSync(CLEAN_LOG, "utf8"), /no leftover TEST artifacts/);
  } finally {
    fs.rmSync(fakeDigest, { force: true });
    fs.rmSync(fakeSnapshot, { force: true });
  }
});
