import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Every test runs a staged copy so the hook never writes into the checkout's own
// ./log/, which the daily log audit reads as a real deployment record.
function sandbox() {
  const root = mkdtempSync(join(ROOT, "tests", ".tmp-post-merge-"));
  const repo = join(root, "repo");
  const configDir = join(root, "config", "opencode");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  cpSync(join(ROOT, "install.sh"), join(repo, "install.sh"));
  cpSync(join(ROOT, "install"), join(repo, "install"), { recursive: true });
  cpSync(join(ROOT, "dist"), join(repo, "dist"), { recursive: true });
  cpSync(join(ROOT, "scripts", "post-merge-hook.sh"), join(repo, "scripts", "post-merge-hook.sh"));
  return { root, repo, configDir };
}

function runHook(repo, configDir) {
  return spawnSync("bash", [join(repo, "scripts", "post-merge-hook.sh")], {
    cwd: repo,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

// install.sh writes its own install.<day>.log next to the hook transcript, so
// the hook's file is selected by prefix rather than by counting the directory.
function logFiles(repo) {
  return readdirSync(join(repo, "log")).filter((name) => name.startsWith("post-merge-hook."));
}

test("post-merge hook logs the transcript and prints one status line", () => {
  const { root, repo, configDir } = sandbox();
  try {
    mkdirSync(join(repo, "log"), { recursive: true });

    const result = runHook(repo, configDir);

    assert.equal(result.status, 0, `hook failed: ${result.stderr}`);
    assert.equal(result.stdout, "✅ post-merge install\n");
    const files = logFiles(repo);
    assert.equal(files.length, 1, `expected one log file, got ${files.join(", ")}`);
    const log = readFileSync(join(repo, "log", files[0]), "utf8");
    assert.match(log, /\[info\] \[stage:install\] post-merge install begin/);
    assert.match(log, /\[pass\] \[stage:install\] post-merge install finished/);
    // install.sh's own transcript must land in the same file, not on screen.
    assert.match(log, /\[info\] installed .*opencode-auto-compact\.ts/);
    assert.ok(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-merge hook still installs when its ./log/ is not writable", () => {
  // A shared checkout can carry a ./log/ owned by another account. The hook used
  // to abort on the first write with a bare "Permission denied" and leave no log
  // and no status line (issue 25d30ec0).
  const { root, repo, configDir } = sandbox();
  try {
    mkdirSync(join(repo, "log"), { recursive: true });
    chmodSync(join(repo, "log"), 0o500);

    const result = runHook(repo, configDir);

    assert.equal(result.status, 0, `hook failed: ${result.stderr}`);
    assert.match(result.stdout, /✅ post-merge install（日志已降级 stderr）/);
    assert.match(result.stderr, /\[info\] \[stage:install\] post-merge install begin/);
    assert.match(result.stderr, /\[pass\] \[stage:install\] post-merge install finished/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Permission denied/);
    assert.deepEqual(logFiles(repo), [], "an unwritable log dir must not receive a log file");
    assert.ok(
      existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")),
      "the entry must still be installed",
    );
  } finally {
    chmodSync(join(repo, "log"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-merge hook reports a failed install when its ./log/ is not writable", () => {
  const { root, repo, configDir } = sandbox();
  try {
    mkdirSync(join(repo, "log"), { recursive: true });
    chmodSync(join(repo, "log"), 0o500);
    // A second entry in a scanned dir fails install.sh, so the hook must reach
    // fail() and name the degraded log target instead of dying on line 18.
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(
      join(configDir, "plugins", "opencode-auto-compact-extra.ts"),
      "export default {};\n",
    );

    const result = runHook(repo, configDir);

    assert.equal(result.status, 1, `expected a failing hook, got ${result.status}`);
    assert.match(result.stderr, /❌ post-merge install（日志不可写，已降级 stderr）/);
    assert.match(result.stderr, /\[fail\] \[stage:install\] install\.sh failed/);
    assert.doesNotMatch(result.stderr, /Permission denied/);
    assert.deepEqual(logFiles(repo), []);
  } finally {
    chmodSync(join(repo, "log"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
