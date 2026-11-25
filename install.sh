#!/usr/bin/env bash
# Install opencode-auto-compact into the OpenCode config directory.
#
# The installer only copies the prebuilt plugin files: no build, no package
# installation and no edit of opencode.json.
#
# OpenCode plugin install contract (summary, see README "安装布局与验收"):
#   - a single entry at <config>/plugin/opencode-auto-compact.ts: both host
#     generations scan scattered files in `plugin/` and `plugins/`, so a second
#     copy is loaded twice per host;
#   - the shared library lives outside both scanned dirs, at
#     <config>/opencode-auto-compact-lib/, so only the entry is discovered;
#   - the runtime still claims activation once per process (globalThis guard),
#     as a defense layer only;
#   - acceptance: v1 and v2 startup logs contain zero
#     "failed to load plugin" lines and exactly one entry over >=3 rounds each.
# Runtime logs are written to
#   ${XDG_STATE_HOME:-$HOME/.local/state}/opencode-auto-compact/auto-compact.log
# when the host exposes no log service (opencode 2.x). This installer logs to
# ./log/install.YYYYMMDD.log and falls back to stderr when that is unwritable.
#
# Usage:
#   bash install.sh                 install or update the plugin
#   bash install.sh --uninstall     remove the installed plugin files
#   bash install.sh --help          show help
set -euo pipefail

PLUGIN_NAME="opencode-auto-compact"
SCRIPT_DIR="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/opencode}"
V1_DIR="${CONFIG_DIR}/plugin"
V2_DIR="${CONFIG_DIR}/plugins"
# Both host generations scan scattered entry files in `plugin/` and `plugins/`
# and opencode2 also treats every first-level subdirectory as a plugin package.
# One entry is therefore enough for both, and a copy in each directory would be
# evaluated twice by the same host. The shared library stays outside both
# directories so the load count equals the entry count.
LIB_DIR="${CONFIG_DIR}/${PLUGIN_NAME}-lib"
# Pre-migration locations removed on install:
#   - plugin/<name>/       library inside the scanned v1 dir (loaded as a plugin)
#   - plugin/<name>-lib/   contract-named library inside the scanned v1 dir
#   - plugins/<name>/      old v2 package directory (loaded as a plugin)
#   - plugins/<name>.ts    duplicate entry, previously installed next to the
#                          canonical plugin/ entry (loaded twice by both hosts)
LEGACY_PATHS=(
  "${V1_DIR}/${PLUGIN_NAME}"
  "${V1_DIR}/${PLUGIN_NAME}-lib"
  "${V2_DIR}/${PLUGIN_NAME}"
  "${V2_DIR}/${PLUGIN_NAME}.ts"
)
LEGACY_PARENTS=("${V1_DIR}" "${V1_DIR}" "${V2_DIR}" "${V2_DIR}")
V1_ENTRY="${V1_DIR}/${PLUGIN_NAME}.ts"
V1_SOURCE="${SCRIPT_DIR}/install/${PLUGIN_NAME}.ts"
DIST_DIR="${SCRIPT_DIR}/dist"
LOG_DIR="${SCRIPT_DIR}/log"
LOG_FILE="${LOG_DIR}/install.$(date +%Y%m%d).log"
readonly PLUGIN_NAME SCRIPT_DIR CONFIG_DIR V1_DIR V2_DIR LIB_DIR
readonly LEGACY_PATHS LEGACY_PARENTS V1_ENTRY
readonly V1_SOURCE DIST_DIR LOG_DIR

# Logging must never decide whether an install succeeds. The checkout can belong
# to another account, so ./log/ may exist but stay unwritable; `tee -a` then
# aborted the whole install with "Permission denied". When the log file cannot
# be opened the line goes to stderr instead and the install continues.
if ! mkdir -p -- "${LOG_DIR}" 2>/dev/null || [[ ! -w "${LOG_DIR}" ]]; then
  LOG_FILE=""
fi

log() {
  local level="$1"
  shift
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] $*"
  if [[ -n "${LOG_FILE}" ]] && printf '%s\n' "${line}" >>"${LOG_FILE}" 2>/dev/null; then
    printf '%s\n' "${line}"
    return
  fi
  # Drop the unusable log target so every later line takes the stderr path.
  LOG_FILE=""
  printf '%s\n' "${line}" >&2
}

die() {
  log error "$*"
  exit 1
}

usage() {
  cat <<'EOF'
Install opencode-auto-compact into the OpenCode config directory.

Usage:
  bash install.sh                 install (or update) the plugin
  bash install.sh --uninstall     remove the installed plugin files
  bash install.sh --help          show this help

Environment:
  OPENCODE_CONFIG_DIR             target config dir
                                  (default: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode)

The installer never builds, installs packages or edits opencode.json.

A config directory this account cannot write (for example one owned by the
platform account) is handled explicitly: when the installed entry and library
already match this checkout the run succeeds as a no-op without touching file
timestamps; when they differ the run fails and names the owner that has to
deploy, so an outdated copy is never reported as installed.

Restart OpenCode after installing so the plugin is loaded.
EOF
}

assert_safe_path() {
  local target="$1"
  local parent="$2"
  [[ -n "${target}" && "${target}" == "${parent}/"* ]] ||
    die "refusing to operate on unexpected path: ${target}"
}

write_entry() {
  local source="$1"
  local target="$2"
  local tmp
  if [[ -f "${target}" ]] && cmp -s -- "${source}" "${target}"; then
    # Contract R6: unchanged content keeps its timestamp so a repeated install
    # does not look like a new deployment to the host's file watcher.
    if [[ "$(stat -c '%a' -- "${target}")" != "644" ]]; then
      chmod 0644 -- "${target}"
    fi
    log info "unchanged ${target}"
    return
  fi
  tmp="$(mktemp "${target}.XXXXXX")"
  if ! install -m 0644 -- "${source}" "${tmp}"; then
    rm -f -- "${tmp}"
    die "failed to stage ${target}"
  fi
  if ! mv -f -- "${tmp}" "${target}"; then
    rm -f -- "${tmp}"
    die "failed to install ${target}"
  fi
  log info "installed ${target}"
}

# True when the installed library already matches the staged content and mode,
# so the swap can be skipped without touching mtimes (contract R6).
lib_is_current() {
  local staged="$1"
  [[ -d "${LIB_DIR}" ]] || return 1
  # Accept inherited setgid (2755) as long as other users can traverse and read;
  # verify_installed_permissions enforces the same bits.
  local dir_mode
  dir_mode="$(stat -c '%a' -- "${LIB_DIR}")"
  (((8#${dir_mode} & 8#005) == 8#005)) || return 1
  local expected actual
  expected="$(cd -- "${staged}" && printf '%s\n' * | sort)"
  actual="$(cd -- "${LIB_DIR}" && printf '%s\n' * | sort)"
  [[ "${expected}" == "${actual}" ]] || return 1
  local name file_mode
  while IFS= read -r name; do
    [[ -f "${staged}/${name}" && -f "${LIB_DIR}/${name}" ]] || return 1
    cmp -s -- "${staged}/${name}" "${LIB_DIR}/${name}" || return 1
    file_mode="$(stat -c '%a' -- "${LIB_DIR}/${name}")"
    (((8#${file_mode} & 8#004) == 8#004)) || return 1
  done <<<"${expected}"
  return 0
}

# True when the installed entry and library already equal what this checkout
# would deploy. Only used for a config dir this account cannot write: a
# deployment there is a no-op when nothing changed and a hard failure when the
# host would otherwise keep running an older build.
installed_is_current() {
  local name
  [[ -d "${DIST_DIR}" ]] || return 1
  [[ -f "${V1_ENTRY}" ]] && cmp -s -- "${V1_SOURCE}" "${V1_ENTRY}" || return 1
  [[ -d "${LIB_DIR}" ]] || return 1
  [[ -f "${LIB_DIR}/index.mjs" && -f "${LIB_DIR}/package.json" ]] || return 1

  local expected actual
  expected="$(
    cd -- "${DIST_DIR}" && printf '%s\n' *.js
    printf '%s\n' index.mjs package.json
  )"
  expected="$(printf '%s\n' "${expected}" | sort)"
  actual="$(cd -- "${LIB_DIR}" && printf '%s\n' * | sort)"
  [[ "${expected}" == "${actual}" ]] || return 1

  while IFS= read -r name; do
    [[ "${name}" == "index.mjs" || "${name}" == "package.json" ]] && continue
    cmp -s -- "${DIST_DIR}/${name}" "${LIB_DIR}/${name}" || return 1
  done <<<"${expected}"

  cmp -s -- "${LIB_DIR}/index.mjs" <(
    printf '%s\n' 'export { default } from "./index.js";'
    printf '%s\n' 'export * from "./index.js";'
  ) || return 1
  cmp -s -- "${LIB_DIR}/package.json" <(
    printf '{\n  "name": "%s",\n  "type": "module"\n}\n' "${PLUGIN_NAME}"
  ) || return 1
  return 0
}

# Remove every pre-migration path. Each name must be a direct child of a
# scanned directory; the guards fail closed on anything else.
cleanup_legacy_paths() {
  local index path parent
  for index in "${!LEGACY_PATHS[@]}"; do
    path="${LEGACY_PATHS[index]}"
    parent="${LEGACY_PARENTS[index]}"
    assert_safe_path "${path}" "${parent}"
    if [[ -e "${path}" || -L "${path}" ]]; then
      rm -rf -- "${path}"
      log info "removed legacy path ${path}"
    fi
  done
}

# The host imports the entry from its own process account, which is not
# necessarily the account that ran install.sh. Directories need other-execute
# and files need other-read; anything narrower makes the import fail before a
# hook exists, so the plugin silently does nothing. Fail closed here instead of
# leaving a broken install behind.
verify_installed_permissions() {
  local path mode
  for path in "${LIB_DIR}" "${LIB_DIR}"/*.js "${LIB_DIR}/index.mjs" "${LIB_DIR}/package.json" "${V1_ENTRY}"; do
    [[ -e "${path}" ]] || die "missing installed path: ${path}"
    mode="$(stat -c '%a' -- "${path}")"
    if [[ -d "${path}" ]]; then
      (((8#${mode} & 8#005) == 8#005)) ||
        die "installed dir is not traversable by other users: ${path} (mode ${mode}, owner $(stat -c '%U' -- "${path}"), running as $(id -un))"
    else
      (((8#${mode} & 8#004) == 8#004)) ||
        die "installed file is not readable by other users: ${path} (mode ${mode}, owner $(stat -c '%U' -- "${path}"), running as $(id -un))"
    fi
  done
}

# Both hosts load every scattered file named `<plugin-name>*` in the two scan
# dirs. Exactly one entry may exist, otherwise the same host evaluates this
# plugin two or more times. Fail closed so a broken layout never ships.
verify_single_entry() {
  local count=0 path
  for path in "${V1_DIR}/${PLUGIN_NAME}"* "${V2_DIR}/${PLUGIN_NAME}"*; do
    [[ -e "${path}" || -L "${path}" ]] || continue
    count=$((count + 1))
  done
  ((count == 1)) || die "expected exactly 1 plugin entry in scan dirs, found ${count}"
}

install_plugin() {
  [[ -f "${DIST_DIR}/index.js" ]] ||
    die "dist/index.js is missing. Build it first: npm ci && npm run build"
  [[ -f "${V1_SOURCE}" ]] || die "missing entry template: ${V1_SOURCE}"

  # The config dir can belong to another account (platform-owned install area).
  # Writing is then impossible, so the run is either a verified no-op or a hard
  # failure; it must never report success while the host runs an older build.
  if [[ -d "${CONFIG_DIR}" && ! -w "${CONFIG_DIR}" ]]; then
    local owner
    owner="$(stat -c '%U' -- "${CONFIG_DIR}" 2>/dev/null || printf 'unknown')"
    if installed_is_current; then
      verify_single_entry
      verify_installed_permissions
      # [log-review] warn not error: a read-only config dir owned by the
      # platform account is an accepted environment state, and the deployed
      # content already equals this checkout, so nothing is stale or lost.
      log warn "config dir ${CONFIG_DIR} is not writable by $(id -un) (owner ${owner}); installed content already current, deployment skipped"
      return 0
    fi
    die "config dir ${CONFIG_DIR} is not writable by $(id -un) (owner ${owner}) and installed content differs from this checkout; ${owner} must deploy: bash install.sh"
  fi

  local mkdir_error
  if ! mkdir_error="$(mkdir -p -- "${V1_DIR}" "${V2_DIR}" 2>&1)"; then
    die "cannot create plugin directories under ${CONFIG_DIR}: ${mkdir_error}"
  fi

  assert_safe_path "${LIB_DIR}" "${CONFIG_DIR}"
  assert_safe_path "${V1_ENTRY}" "${V1_DIR}"

  local staging backup
  staging="$(mktemp -d "${CONFIG_DIR}/.${PLUGIN_NAME}-lib.stage.XXXXXX")"
  # mktemp -d creates 0700 (plus inherited setgid) and `mv` preserves that mode.
  # The host may run as a different account than the installer, so the module
  # dir must be traversable by other users or `import` fails with EACCES before
  # any hook is registered (silent plugin load failure).
  chmod 0755 -- "${staging}"
  backup="${LIB_DIR}.old.$$"
  # shellcheck disable=SC2064 # expand the temp paths now, not at exit time
  trap "rm -rf -- '${staging}' '${backup}'" EXIT

  install -m 0644 -- "${DIST_DIR}"/*.js "${staging}/"
  cat >"${staging}/package.json" <<EOF
{
  "name": "${PLUGIN_NAME}",
  "type": "module"
}
EOF
  # Contract R2 names the import target index.mjs. The built modules stay .js;
  # this one-line ESM re-export keeps the documented entry path stable.
  cat >"${staging}/index.mjs" <<'EOF'
export { default } from "./index.js";
export * from "./index.js";
EOF
  chmod 0644 -- "${staging}/package.json" "${staging}/index.mjs"

  if lib_is_current "${staging}"; then
    rm -rf -- "${staging}"
    log info "library unchanged (${LIB_DIR}/)"
  else
    # Swap the module directory through a backup rename: the host never sees a
    # half copied library, and a failed activation restores the previous one.
    if [[ -e "${LIB_DIR}" ]]; then
      mv -- "${LIB_DIR}" "${backup}"
    fi
    if ! mv -- "${staging}" "${LIB_DIR}"; then
      if [[ -e "${backup}" ]]; then
        mv -- "${backup}" "${LIB_DIR}"
      fi
      die "failed to activate ${LIB_DIR}"
    fi
    rm -rf -- "${backup}"
    chmod 0755 -- "${LIB_DIR}"
    log info "installed ${LIB_DIR}/"
  fi
  trap - EXIT

  write_entry "${V1_SOURCE}" "${V1_ENTRY}"

  # Drop pre-migration paths: directories are loaded as extra plugins and the
  # old `plugins/<name>.ts` duplicate is evaluated a second time by both hosts.
  # Removal happens after the canonical entry is in place so a failure leaves a
  # loadable plugin, not a dangling import.
  cleanup_legacy_paths

  verify_single_entry
  verify_installed_permissions

  local module_count=0
  local module
  for module in "${LIB_DIR}"/*.js; do
    [[ -e "${module}" ]] && module_count=$((module_count + 1))
  done

  log info "library has ${module_count} modules"
  warn_duplicate_registration
  log info "restart OpenCode to load the plugin"
}

# A host-native registration plus these local copies would load the plugin
# twice. The plugin de-duplicates itself in-process, but the duplicate entry is
# still worth flagging.
# [log-review] warn downgraded from error: (1) a leftover opencode.json entry is
# an expected legacy state; (2) the runtime de-duplicates itself in-process, so
# the host is not harmed and error would be misleading; (3) triggers only when a
# config file still names the plugin, impact is one redundant load attempt.
warn_duplicate_registration() {
  local config_file
  for config_file in "${CONFIG_DIR}/opencode.json" "${CONFIG_DIR}/opencode.jsonc"; do
    [[ -f "${config_file}" ]] || continue
    if contains_plugin_name "${config_file}"; then
      log warn "${config_file} still registers ${PLUGIN_NAME}; remove that entry to avoid a duplicate registration"
    fi
  done
}

contains_plugin_name() {
  local file="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -q --fixed-strings -- "${PLUGIN_NAME}" "${file}"
    return
  fi
  # Degraded CLI: rg is unavailable in this environment.
  grep -q --fixed-strings -- "${PLUGIN_NAME}" "${file}"
}

uninstall_plugin() {
  assert_safe_path "${LIB_DIR}" "${CONFIG_DIR}"
  assert_safe_path "${V1_ENTRY}" "${V1_DIR}"

  rm -rf -- "${LIB_DIR}"
  rm -f -- "${V1_ENTRY}"
  cleanup_legacy_paths

  log info "removed ${V1_ENTRY}"
  log info "removed ${LIB_DIR}/"
  log info "restart OpenCode to unload the plugin"
}

main() {
  case "${1:-}" in
  -h | --help)
    usage
    ;;
  --uninstall)
    uninstall_plugin
    ;;
  "")
    install_plugin
    ;;
  *)
    die "unknown argument: $1 (try --help)"
    ;;
  esac
}

main "$@"
