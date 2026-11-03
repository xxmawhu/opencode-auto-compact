#!/usr/bin/env bash
# Install opencode-auto-compact into the OpenCode config directory.
#
# The installer only copies the prebuilt plugin files: no build, no package
# installation and no edit of opencode.json.
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
LIB_DIR="${V1_DIR}/${PLUGIN_NAME}"
V1_ENTRY="${V1_DIR}/${PLUGIN_NAME}.ts"
V2_ENTRY="${V2_DIR}/${PLUGIN_NAME}.ts"
V1_SOURCE="${SCRIPT_DIR}/install/${PLUGIN_NAME}.ts"
V2_SOURCE="${SCRIPT_DIR}/install/${PLUGIN_NAME}-v2.ts"
DIST_DIR="${SCRIPT_DIR}/dist"
LOG_DIR="${SCRIPT_DIR}/log"
LOG_FILE="${LOG_DIR}/install.$(date +%Y%m%d).log"
readonly PLUGIN_NAME SCRIPT_DIR CONFIG_DIR V1_DIR V2_DIR LIB_DIR V1_ENTRY V2_ENTRY
readonly V1_SOURCE V2_SOURCE DIST_DIR LOG_DIR LOG_FILE

mkdir -p -- "${LOG_DIR}"

log() {
  local level="$1"
  shift
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${level}" "$*" | tee -a "${LOG_FILE}"
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
  tmp="$(mktemp "${target}.XXXXXX")"
  if ! install -m 0644 -- "${source}" "${tmp}"; then
    rm -f -- "${tmp}"
    die "failed to stage ${target}"
  fi
  if ! mv -f -- "${tmp}" "${target}"; then
    rm -f -- "${tmp}"
    die "failed to install ${target}"
  fi
}

install_plugin() {
  [[ -f "${DIST_DIR}/index.js" ]] ||
    die "dist/index.js is missing. Build it first: npm ci && npm run build"
  [[ -f "${V1_SOURCE}" ]] || die "missing entry template: ${V1_SOURCE}"
  [[ -f "${V2_SOURCE}" ]] || die "missing entry template: ${V2_SOURCE}"

  local mkdir_error
  if ! mkdir_error="$(mkdir -p -- "${V1_DIR}" "${V2_DIR}" 2>&1)"; then
    die "cannot create plugin directories under ${CONFIG_DIR}: ${mkdir_error}"
  fi

  assert_safe_path "${LIB_DIR}" "${V1_DIR}"
  assert_safe_path "${V1_ENTRY}" "${V1_DIR}"
  assert_safe_path "${V2_ENTRY}" "${V2_DIR}"

  local staging backup
  staging="$(mktemp -d "${V1_DIR}/.${PLUGIN_NAME}.stage.XXXXXX")"
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
  chmod 0644 -- "${staging}/package.json"

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
  trap - EXIT

  write_entry "${V1_SOURCE}" "${V1_ENTRY}"
  write_entry "${V2_SOURCE}" "${V2_ENTRY}"

  local module_count=0
  local module
  for module in "${LIB_DIR}"/*.js; do
    [[ -e "${module}" ]] && module_count=$((module_count + 1))
  done

  log info "installed ${V1_ENTRY}"
  log info "installed ${V2_ENTRY}"
  log info "installed ${LIB_DIR}/ (${module_count} modules)"
  warn_duplicate_registration
  log info "restart OpenCode to load the plugin"
}

# A host-native registration plus these local copies would load the plugin
# twice. The plugin de-duplicates itself in-process, but the duplicate entry is
# still worth flagging.
# WARN (downgraded from error): a duplicate registration makes the host load
# the plugin twice; the runtime de-duplicates itself, so this stays advisory.
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
  assert_safe_path "${LIB_DIR}" "${V1_DIR}"
  assert_safe_path "${V1_ENTRY}" "${V1_DIR}"
  assert_safe_path "${V2_ENTRY}" "${V2_DIR}"

  rm -rf -- "${LIB_DIR}"
  rm -f -- "${V1_ENTRY}" "${V2_ENTRY}"

  log info "removed ${V1_ENTRY}"
  log info "removed ${V2_ENTRY}"
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