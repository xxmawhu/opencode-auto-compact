#!/usr/bin/env bash
# Refresh the installed plugin copy after a `git pull`.
#
# Screen output is a single status line; the full transcript goes to
# log/post-merge-hook.YYYYMMDD.log.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOG_DIR="${SCRIPT_DIR}/log"
LOG_FILE="${LOG_DIR}/post-merge-hook.$(date +%Y%m%d).log"
readonly SCRIPT_DIR LOG_DIR LOG_FILE

mkdir -p -- "${LOG_DIR}"

log() {
  local level="$1"
  shift
  printf '[%s] [%s] [stage:install] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${level}" "$*" >>"${LOG_FILE}"
}

fail() {
  log fail "$*"
  printf '❌ post-merge install（详见 log/%s）\n' "$(basename -- "${LOG_FILE}")"
  exit 1
}

log info "post-merge install begin"

if ! bash "${SCRIPT_DIR}/install.sh" >>"${LOG_FILE}" 2>&1; then
  fail "install.sh failed"
fi

log pass "post-merge install finished"
printf '✅ post-merge install\n'