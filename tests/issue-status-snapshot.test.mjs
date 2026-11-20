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
  const stub = path.join(dir, "raise-issue");
  fs.writeFileSync(
    stub,
    [
      "#!/bin/bash",
      `printf 'issue_id:         %s\\nstatus:           done\\nreplied_at:       2026-11-19T00:00:00Z\\n' "$2"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return stub;
}

function runScript(stub) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, RAISE_OVERRIDE: stub },
  });
}

test("an unchanged status snapshot publishes no second digest", () => {
  removeArtifacts();
  const tmp = fs.mkdtempSync(path.join(ROOT, "tests", ".tmp-issue-status-"));
  try {
    const stub = writeStubStable(tmp);

    const first = runScript(stub);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(DIGEST), "first run publishes a digest");
    const digestBefore = fs.readFileSync(DIGEST, "utf8");
    assert.ok(digestBefore.length > 0);
    // The TEST digest must not point at the production log: naming the wrong
    // file makes a stubbed statuses table look like a real transition.
    assert.match(digestBefore, new RegExp(`issue-status-test\\.${stamp}\\.log`));
    assert.doesNotMatch(digestBefore, new RegExp(`issue-status\\.${stamp}\\.log`));
    const logBefore = fs.readFileSync(LOG, "utf8");

    const second = runScript(stub);
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
