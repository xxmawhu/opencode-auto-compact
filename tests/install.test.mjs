import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

test("install.sh copies the v1 entry, the shared library and the v2 entry", () => {
  const configDir = sandbox();
  try {
    run([], configDir);

    const v1Entry = join(configDir, "plugin", "opencode-auto-compact.ts");
    const v2Entry = join(configDir, "plugins", "opencode-auto-compact.ts");
    const lib = join(configDir, "plugin", "opencode-auto-compact", "index.js");
    const pkg = join(configDir, "plugin", "opencode-auto-compact", "package.json");

    for (const file of [v1Entry, v2Entry, lib, pkg]) {
      assert.ok(existsSync(file), `missing ${file}`);
      assert.equal(statSync(file).mode & 0o777, 0o644, `unexpected mode for ${file}`);
    }
    assert.match(readFileSync(v1Entry, "utf8"), /\.\/opencode-auto-compact\/index\.js/);
    assert.match(readFileSync(v2Entry, "utf8"), /\.\.\/plugin\/opencode-auto-compact\/index\.js/);
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

test("install.sh --uninstall removes every installed file", () => {
  const configDir = sandbox();
  try {
    run([], configDir);
    run(["--uninstall"], configDir);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact.ts")), false);
    assert.equal(existsSync(join(configDir, "plugins", "opencode-auto-compact.ts")), false);
    assert.equal(existsSync(join(configDir, "plugin", "opencode-auto-compact")), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
