#!/bin/bash
# Daily snapshot of the audit's filed issues.
#
# Plan item: re-check every filed issue's state each day until it reaches
# fixed/confirmed. Doing that by hand is the step most likely to be skipped on
# a busy day, so this job records all states and drops one digest the first day
# an issue leaves `doing` (or starts being replied to).
#
# Zero arguments, zero environment variables, always exits 0: a monitoring job
# must never fail the scheduler.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
STAMP="$(date +%Y%m%d)"
LEDGER="${ROOT}/audit/pending-issues.json"

# A status snapshot is evidence, so a stubbed CLI must never be able to write a
# production-looking digest. Tests inject RAISE_OVERRIDE; that mode gets TEST
# in every artifact name, making it impossible to mistake for a real change.
if [[ -n "${RAISE_OVERRIDE:-}" ]]; then
	LOG="${ROOT}/log/issue-status-test.${STAMP}.log"
	DIGEST="${ROOT}/issues/issue-status-change-TEST-${STAMP}.md"
else
	LOG="${ROOT}/log/issue-status.${STAMP}.log"
	DIGEST="${ROOT}/issues/issue-status-change-${STAMP}.md"
fi

log_line() {
	local level="$1"
	shift
	printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "${level}" "$*" >>"${LOG}"
}

resolve_raise() {
	local candidate
	# RAISE_OVERRIDE exists only so tests can inject a stub CLI; the scheduled
	# job never sets it and falls through to the real binary.
	for candidate in "${RAISE_OVERRIDE:-}" "${HOME}/.local/bin/raise-issue"; do
		if [[ -n "${candidate}" && -x "${candidate}" ]]; then
			printf '%s' "${candidate}"
			return 0
		fi
	done
	return 1
}

write_digest() {
	local tmp="$1"
	shift
	local -a lines=("$@")
	{
		printf '# issue 状态变化 %s\n\n' "${STAMP}"
		if [[ -n "${RAISE_OVERRIDE:-}" ]]; then
			printf '> 模式：TEST（注入桩 CLI，表中状态为伪造值，**不可作为修复证据**）\n\n'
		fi
		printf -- '- 快照日志：`log/issue-status.%s.log`\n' "${STAMP}"
		printf -- '- 台账：`audit/pending-issues.json`\n\n'
		printf '| issue | target | status | replied_at |\n|---|---|---|---|\n'
		printf '%s\n' "${lines[@]}"
	} >"${tmp}"
}

main() {
	mkdir -p "${ROOT}/log" "${ROOT}/issues" || exit 0

	if [[ ! -f "${LEDGER}" ]]; then
		log_line error "FAILED ledger missing: ${LEDGER}"
		exit 0
	fi

	local raise
	raise="$(resolve_raise)" || {
		log_line error "FAILED raise-issue CLI not executable"
		exit 0
	}

	local -a ids=() targets=()
	local id target
	while IFS=$'\t' read -r id target; do
		[[ -n "${id}" ]] || continue
		ids+=("${id}")
		targets+=("${target}")
	done < <(python3 -c '
import json, sys
for row in json.load(open(sys.argv[1])):
    print(row["id"] + "\t" + row.get("target", "?"))
' "${LEDGER}" 2>/dev/null)

	if [[ ${#ids[@]} -eq 0 ]]; then
		log_line error "FAILED no issues parsed from ${LEDGER}"
		exit 0
	fi

	local -a changed=() unreachable=()
	local i status replied
	for i in "${!ids[@]}"; do
		id="${ids[$i]}"
		replied="-"
		status="unreachable"
		local out attempt
		# Retry once: the ZMQ server behind raise-issue occasionally fails a single
		# query under cron load (2026-11-19 09:20 run reported all 14 issues as
		# unreachable while a manual run at 09:23 succeeded). Without the retry a
		# transient miss writes a false "all changed" digest into issues/.
		# Loop bound is the literal set {1,2}: two attempts, then report and move on.
		for attempt in 1 2; do
			out="$("${raise}" status "${id}" 2>&1)" || true
			if printf '%s\n' "${out}" | rg -q '^issue_id:'; then
				break
			fi
			if [[ "${attempt}" -eq 1 ]]; then
				sleep 2
			fi
		done
		if printf '%s\n' "${out}" | rg -q '^issue_id:'; then
			status="$(printf '%s\n' "${out}" | awk '/^status:/{print $2; exit}')"
			replied="$(printf '%s\n' "${out}" | awk '/^replied_at:/{print $2; exit}')"
			[[ -n "${status}" ]] || status="unknown"
		fi
		log_line info "${id} target=${targets[$i]} status=${status} replied_at=${replied}"
		# "unreachable" is our own query failure, not a state change. Reporting it
		# as changed wrote a digest full of fake transitions during a ZMQ outage
		# (2026-11-19 09:20 snapshot). Keep it out of the change table and name it
		# as an error so the outage stays visible in the run log.
		if [[ "${status}" == "unreachable" ]]; then
			unreachable+=("${id}")
		elif [[ "${status}" != "doing" || "${replied}" != "-" ]]; then
			changed+=("| \`${id}\` | ${targets[$i]} | ${status} | ${replied} |")
		fi
	done

	if [[ ${#unreachable[@]} -gt 0 ]]; then
		log_line error "FAILED status unreachable for ${#unreachable[@]} of ${#ids[@]} issues: ${unreachable[*]}"
	fi

	if [[ ${#changed[@]} -eq 0 ]]; then
		if [[ ${#unreachable[@]} -eq 0 ]]; then
			log_line info "OK all ${#ids[@]} issues still doing/unreplied"
		fi
		exit 0
	fi

	local tmp
	tmp="$(mktemp "${DIGEST}.tmp.XXXXXX")" || exit 0
	if ! write_digest "${tmp}" "${changed[@]}"; then
		rm -f "${tmp}"
		exit 0
	fi
	if mv -f "${tmp}" "${DIGEST}"; then
		log_line info "CHANGED ${#changed[@]} of ${#ids[@]} issues, digest=${DIGEST}"
	else
		rm -f "${tmp}"
		log_line error "FAILED cannot publish digest: ${DIGEST}"
	fi
	exit 0
}

main "$@"
