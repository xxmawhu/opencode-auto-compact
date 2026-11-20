#!/usr/bin/env bash
# Refresh the installed plugin copy after a `git pull`.
#
# Screen output is a single status line; the full transcript goes to
# log/post-merge-hook.YYYYMMDD.log and degrades to stderr when that file cannot
# be written.
#
# Logging must never decide whether the hook succeeds. The checkout can belong to
# another account, so ./log/ may exist but stay unwritable; an unconditional
# `printf >>LOG_FILE` then returned non-zero and `set -e` aborted the hook before
# install.sh ran, leaving only a bare "Permission denied" on screen, no status
# line and no log file (issue 25d30ec0). install.sh already degrades the same
# way, so both entry points now behave identically under a read-only checkout.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOG_DIR="${SCRIPT_DIR}/log"
LOG_FILE="${LOG_DIR}/post-merge-hook.$(date +%Y%m%d).log"
readonly SCRIPT_DIR LOG_DIR

if ! mkdir -p -- "${LOG_DIR}" 2>/dev/null || [[ ! -w "${LOG_DIR}" ]]; then
	LOG_FILE=""
fi

log() {
	local level="$1"
	shift
	local line
	line="[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] [stage:install] $*"
	if [[ -n "${LOG_FILE}" ]] && printf '%s\n' "${line}" >>"${LOG_FILE}" 2>/dev/null; then
		return
	fi
	# Drop the unusable log target so every later line takes the stderr path.
	LOG_FILE=""
	printf '%s\n' "${line}" >&2
}

fail() {
	log fail "$*"
	if [[ -n "${LOG_FILE}" ]]; then
		printf '❌ post-merge install（详见 log/%s）\n' "$(basename -- "${LOG_FILE}")"
	else
		printf '❌ post-merge install（日志不可写，已降级 stderr）\n' >&2
	fi
	exit 1
}

run_install() {
	if [[ -n "${LOG_FILE}" ]]; then
		bash "${SCRIPT_DIR}/install.sh" >>"${LOG_FILE}" 2>&1
	else
		bash "${SCRIPT_DIR}/install.sh" >&2
	fi
}

log info "post-merge install begin"

# The status line reports the outcome of install.sh only; the log target never
# decides the exit code.
if ! run_install; then
	fail "install.sh failed"
fi

log pass "post-merge install finished"
if [[ -n "${LOG_FILE}" ]]; then
	printf '✅ post-merge install\n'
else
	printf '✅ post-merge install（日志已降级 stderr）\n'
fi
