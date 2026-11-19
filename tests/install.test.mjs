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
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const INSTALLER = join(ROOT, "install.sh");

// Every test runs a staged copy of the installer, never the checkout's own.
// install.sh logs to `<script dir>/log/install.<day>.log`, so a negative test
// that expects `die` would otherwise write an `[error]` line into the project's
// real install log and the daily log audit would report it as a live defect
// (observed on compute-server-98-7, log/install.20261118.log).
function sandbox() {
  const root = mkdtempSync(join(ROOT, "tests", ".tmp-install-"));
  const repo = join(root, "repo");
  const configDir = join(root, "config", "opencode");
  cpSync(INSTALLER, join(repo, "install.sh"));
  cpSync(join(ROOT, "install"), join(repo, "install"), { recursive: true });
  cpSync(join(ROOT, "dist"), join(repo, "dist"), { recursive: true });
  return { root, repo, configDir };
}

function run(args, repo, configDir) {
  return execFileSync("bash", [join(repo, "install.sh"), ...args], {
    cwd: repo,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

test("the single entry template default-exports the shared definition object", () => {
  const source = readFileSync(join(ROOT, "install", "opencode-auto-compact.ts"), "utf8");
  // opencode2 rejects a function default export with
  // SchemaError(Expected object at ["default"]), so the entry must re-export
  // the shared object rather than wrap it in a function.
  assert.match(source, /export default hybrid;/, "entry must re-export the hybrid object");
  assert.doesNotMatch(source, /export const Plugin/, "entry must not add function exports");
});

test("install.sh copies one entry and the shared library", () => {
  const { root, repo, configDir } = sandbox();
  try {
    run([], repo, configDir);

    const entry = join(configDir, "plugin", "opencode-auto-compact.ts");
    // The shared library must stay outside `plugin/` and `plugins/`: opencode2
    // loads every first-level directory under those paths as a plugin entry.
    const libDir = join(configDir, "opencode-auto-compact-lib");
    const lib = join(libDir, "index.js");
    const libEntry = join(libDir, "index.mjs");
    const pkg = join(libDir, "package.json");

    for (const file of [entry, lib, libEntry, pkg]) {
      assert.ok(existsSync(file), `missing ${file}`);
      assert.equal(statSync(file).mode & 0o777, 0o644, `unexpected mode for ${file}`);
    }
    // The host may run as another account, so the library dir must stay
    // world-traversable (mktemp -d + mv used to leave it at 0700).
    assert.equal(statSync(libDir).mode & 0o777, 0o755, "library dir must be world-traversable");
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact")), false);
    // Both host generations already load the `plugin/` entry, so the second
    // entry under `plugins/` must not be installed.
    assert.equal(existsSync(join(configDir, "plugins", "opencode-auto-compact.ts")), false);
    assert.match(readFileSync(entry, "utf8"), /\.\.\/opencode-auto-compact-lib\/index\.mjs/);
    // Contract R2 names index.mjs as the import target; it must re-export the
    // built ES module rather than duplicate the library.
    assert.match(readFileSync(libEntry, "utf8"), /export \{ default \} from "\.\/index\.js"/);
    assert.equal(JSON.parse(readFileSync(pkg, "utf8")).type, "module");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh removes a duplicate plugins/ entry left by an older install", () => {
  const { root, repo, configDir } = sandbox();
  try {
    const duplicate = join(configDir, "plugins", "opencode-auto-compact.ts");
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(duplicate, "export default {};\n");

    run([], repo, configDir);

    // Both hosts would load this file a second time after the canonical entry.
    assert.equal(existsSync(duplicate), false, `duplicate entry not removed: ${duplicate}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh fails when the scan dirs keep more than one entry", () => {
  const { root, repo, configDir } = sandbox();
  try {
    const stray = join(configDir, "plugins", "opencode-auto-compact-extra.ts");
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(stray, "export default {};\n");

    let output = "";
    try {
      run([], repo, configDir);
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.match(
      output,
      /expected exactly 1 plugin entry/,
      "a second entry in the scan dirs must fail the install",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh is idempotent and keeps timestamps when content is unchanged", async () => {
  const { root, repo, configDir } = sandbox();
  try {
    run([], repo, configDir);
    const files = [
      join(configDir, "plugin", "opencode-auto-compact.ts"),
      join(configDir, "opencode-auto-compact-lib", "index.js"),
      join(configDir, "opencode-auto-compact-lib", "index.mjs"),
      join(configDir, "opencode-auto-compact-lib", "package.json"),
    ];
    const before = files.map((file) => statSync(file).mtimeMs);
    // Contract R6: unchanged content must not look like a new deployment.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    run([], repo, configDir);
    const after = files.map((file) => statSync(file).mtimeMs);
    assert.deepEqual(after, before, "a repeated install must keep file timestamps");
    for (const file of files) assert.ok(existsSync(file), `missing ${file}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh repairs a stale library dir that is not world-traversable", () => {
  const { root, repo, configDir } = sandbox();
  try {
    const libDir = join(configDir, "opencode-auto-compact-lib");
    mkdirSync(libDir, { recursive: true });
    chmodSync(libDir, 0o700);

    run([], repo, configDir);

    assert.equal(statSync(libDir).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh still installs when its own ./log/ is not writable", () => {
  // A shared checkout can carry a ./log/ owned by another account. `tee -a`
  // used to abort the whole install with EACCES there, so the line now falls
  // back to stderr and the install completes.
  const { root, repo, configDir } = sandbox();
  try {
    mkdirSync(join(repo, "log"), { recursive: true });
    chmodSync(join(repo, "log"), 0o500);

    const result = spawnSync("bash", [join(repo, "install.sh")], {
      cwd: repo,
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `install failed: ${result.stderr}`);
    assert.ok(
      existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")),
      "the entry must still be installed",
    );
    assert.match(result.stderr, /\[info\] installed .*opencode-auto-compact\.ts/);
    assert.deepEqual(
      readdirSync(join(repo, "log")),
      [],
      "an unwritable log dir must not receive a log file",
    );
  } finally {
    chmodSync(join(repo, "log"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh removes every legacy scanned path", () => {
  const { root, repo, configDir } = sandbox();
  try {
    const legacyPaths = [
      join(configDir, "plugin", "opencode-auto-compact"),
      join(configDir, "plugin", "opencode-auto-compact-lib"),
      join(configDir, "plugins", "opencode-auto-compact"),
    ];
    for (const path of legacyPaths) mkdirSync(path, { recursive: true });

    run([], repo, configDir);

    // While these directories exist, opencode2 loads them as extra plugins.
    for (const path of legacyPaths) assert.equal(existsSync(path), false, `not removed: ${path}`);
    assert.ok(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh --uninstall removes every installed file", () => {
  const { root, repo, configDir } = sandbox();
  try {
    run([], repo, configDir);
    const duplicate = join(configDir, "plugins", "opencode-auto-compact.ts");
    writeFileSync(duplicate, "export default {};\n");
    run(["--uninstall"], repo, configDir);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")), false);
    assert.equal(existsSync(duplicate), false);
    assert.equal(existsSync(join(configDir, "opencode-auto-compact-lib")), false);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
