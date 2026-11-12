import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const INSTALLER = join(ROOT, "install.sh");

function sandbox() {
  return mkdtempSync(join(ROOT, "tests", ".tmp-install-"));
}

function run(args, configDir) {
  return execFileSync("bash", [INSTALLER, ...args], {
    cwd: ROOT,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

test("entry templates default-export the shared definition object", () => {
  for (const name of ["opencode-auto-compact.ts", "opencode-auto-compact-v2.ts"]) {
    const source = readFileSync(join(ROOT, "install", name), "utf8");
    // opencode2 rejects a function default export with
    // SchemaError(Expected object at ["default"]), so the entry must re-export
    // the shared object rather than wrap it in a function.
    assert.match(source, /export default hybrid;/, `${name} must re-export the hybrid object`);
    assert.doesNotMatch(source, /export const Plugin/, `${name} must not add function exports`);
  }
});

test("install.sh copies the v1 entry, the shared library and the v2 entry", () => {
  const configDir = sandbox();
  try {
    run([], configDir);

    const v1Entry = join(configDir, "plugin", "opencode-auto-compact.ts");
    const v2Entry = join(configDir, "plugins", "opencode-auto-compact.ts");
    // The shared library must stay outside `plugin/` and `plugins/`: opencode2
    // loads every first-level directory under those paths as a plugin entry.
    const libDir = join(configDir, "opencode-auto-compact-lib");
    const lib = join(libDir, "index.js");
    const pkg = join(libDir, "package.json");

    for (const file of [v1Entry, v2Entry, lib, pkg]) {
      assert.ok(existsSync(file), `missing ${file}`);
      assert.equal(statSync(file).mode & 0o777, 0o644, `unexpected mode for ${file}`);
    }
    // The host may run as another account, so the library dir must stay
    // world-traversable (mktemp -d + mv used to leave it at 0700).
    assert.equal(statSync(libDir).mode & 0o777, 0o755, "library dir must be world-traversable");
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact")), false);
    assert.match(readFileSync(v1Entry, "utf8"), /\.\.\/opencode-auto-compact-lib\/index\.js/);
    assert.match(readFileSync(v2Entry, "utf8"), /\.\.\/opencode-auto-compact-lib\/index\.js/);
    assert.equal(JSON.parse(readFileSync(pkg, "utf8")).type, "module");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("install.sh is idempotent", () => {
  const configDir = sandbox();
  try {
    run([], configDir);
    run([], configDir);
    const v1Entry = join(configDir, "plugin", "opencode-auto-compact.ts");
    assert.ok(existsSync(v1Entry));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("install.sh repairs a stale library dir that is not world-traversable", () => {
  const configDir = sandbox();
  try {
    const libDir = join(configDir, "opencode-auto-compact-lib");
    mkdirSync(libDir, { recursive: true });
    chmodSync(libDir, 0o700);

    run([], configDir);

    assert.equal(statSync(libDir).mode & 0o777, 0o755);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("install.sh removes the legacy library dir from the scanned plugin/ path", () => {
  const configDir = sandbox();
  try {
    const legacyLib = join(configDir, "plugin", "opencode-auto-compact");
    mkdirSync(legacyLib, { recursive: true });

    run([], configDir);

    // While this directory exists, opencode2 loads it as an extra plugin entry.
    assert.equal(existsSync(legacyLib), false);
    assert.ok(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("install.sh --uninstall removes every installed file", () => {
  const configDir = sandbox();
  try {
    run([], configDir);
    run(["--uninstall"], configDir);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")), false);
    assert.equal(existsSync(join(configDir, "plugins", "opencode-auto-compact.ts")), false);
    assert.equal(existsSync(join(configDir, "opencode-auto-compact-lib")), false);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact")), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
