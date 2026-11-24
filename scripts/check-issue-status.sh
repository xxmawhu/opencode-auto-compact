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
# The TEST digest lives in audit/, not issues/: any *.md in issues/ is a backlog
# item for the triage loop, so a crashed test must not be able to leave a fake
# transition there (2026-11-20: the owner mistook a leftover TEST digest for a
# real issue).
if [[ -n "${RAISE_OVERRIDE:-}" ]]; then
	LOG="${ROOT}/log/issue-status-test.${STAMP}.log"
	DIGEST="${ROOT}/audit/issue-status-change-TEST-${STAMP}.md"
	SNAPSHOT="${ROOT}/audit/issue-status-snapshot-TEST.txt"
else
	LOG="${ROOT}/log/issue-status.${STAMP}.log"
	DIGEST="${ROOT}/issues/issue-status-change-${STAMP}.md"
	SNAPSHOT="${ROOT}/audit/issue-status-snapshot.txt"
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
		# Print the log actually used by this run: a TEST digest that names the
		# production log invites a reader to cross-check the wrong file.
		printf -- '- 快照日志：`%s`\n' "${LOG#"${ROOT}"/}"
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

	# Only UUID ids are real raise-issue records. The ledger also carries local
	# observation markers (local-*, observe-*, verify-*) that were never filed,
	# so `raise-issue status` can never answer for them. Querying those produced
	# a permanent `FAILED status unreachable for 18 of 47` error line on every
	# run (first seen 2026-11-19 13:41), which the log audit then reported as a
	# real error of this project. Skip them by id shape instead of by target
	# text, so the fix does not depend on ledger wording.
	local -a ids=() targets=()
	local id row
	local -a parsed=()
	mapfile -t parsed < <(python3 -c '
import json, re, sys
uuid = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
rows = json.load(open(sys.argv[1]))
real = [r for r in rows if uuid.match(str(r.get("id", "")))]
for r in real:
    print(str(r["id"]) + "\t" + str(r.get("target", "?")).replace("\n", " "))
print("SKIPPED\t" + str(len(rows) - len(real)))
' "${LEDGER}" 2>/dev/null)
	local skipped=0
	for row in "${parsed[@]+"${parsed[@]}"}"; do
		if [[ "${row}" == SKIPPED$'\t'* ]]; then
			skipped="${row#SKIPPED$'\t'}"
			continue
		fi
		ids+=("${row%%$'\t'*}")
		targets+=("${row#*$'\t'}")
	done
	if [[ "${skipped}" -gt 0 ]]; then
		log_line info "skipped ${skipped} ledger rows without a raise-issue record (local observations)"
	fi

	if [[ ${#ids[@]} -eq 0 ]]; then
		log_line error "FAILED no issues parsed from ${LEDGER}"
		exit 0
	fi

	local -a changed=() unreachable=() unowned=()
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
			# `raise-issue` derives the caller project from the working directory.
			# Cron runs this script without a cd, so the CLI saw `.../scripts` and
			# answered `STATUS DENIED: caller .../scripts is neither receiver nor
			# sender` for every id (2026-11-20 09:20: 40/40 unreachable). Run from
			# the project root so the caller is the registered sender project.
			out="$(cd "${ROOT}" && "${raise}" status "${id}" 2>&1)" || true
			if printf '%s\n' "${out}" | rg -q '^issue_id:'; then
				break
			fi
			# A refusal is final: retrying cannot make another project's issue
			# readable. Breaking here keeps the 2s retry for real transport misses.
			if printf '%s\n' "${out}" | rg -q 'not related to caller project'; then
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
		elif printf '%s\n' "${out}" | rg -q 'not related to caller project'; then
			# The ledger also records issues that were forwarded to another
			# project (2026-11-24: 4f646127 was filed by a forwarder, so
			# `raise-issue status` answers "Permission denied: issue ... is not
			# related to caller project" — reproduced 3/3). That refusal is a
			# permanent ownership fact, not a query failure, so it must not be
			# reported as an unreachable issue: one such row produced a daily
			# `FAILED status unreachable for 1 of 63` self-audit error.
			status="unowned"
		fi
		log_line info "${id} target=${targets[$i]} status=${status} replied_at=${replied}"
		# "unreachable" is our own query failure, not a state change. Reporting it
		# as changed wrote a digest full of fake transitions during a ZMQ outage
		# (2026-11-19 09:20 snapshot). Keep it out of the change table and name it
		# as an error so the outage stays visible in the run log.
		if [[ "${status}" == "unreachable" ]]; then
			unreachable+=("${id}")
		elif [[ "${status}" == "unowned" ]]; then
			unowned+=("${id}")
		elif [[ "${status}" != "doing" || "${replied}" != "-" ]]; then
			changed+=("| \`${id}\` | ${targets[$i]} | ${status} | ${replied} |")
		fi
	done

	if [[ ${#unowned[@]} -gt 0 ]]; then
		log_line info "skipped ${#unowned[@]} forwarded issue(s) not owned by caller: ${unowned[*]}"
	fi

	if [[ ${#unreachable[@]} -gt 0 ]]; then
		log_line error "FAILED status unreachable for ${#unreachable[@]} of ${#ids[@]} issues: ${unreachable[*]}"
	fi

	if [[ ${#changed[@]} -eq 0 ]]; then
		if [[ ${#unreachable[@]} -eq 0 ]]; then
			log_line info "OK all ${#ids[@]} issues still doing/unreplied"
		fi
		exit 0
	fi

	# A closed issue stays "changed" forever by definition (`status != doing`),
	# so the previous version rewrote a byte-identical 29-row digest on every
	# run: issues/ never stayed clean, and each rerun disguised itself as a new
	# transition. Compare against the last published snapshot (audit/ is
	# gitignored runtime state) and stay silent when nothing actually moved.
	# Evidence: the 15:30 run reproduced the 14:22 digest with 0 differing rows.
	local snapshot="${SNAPSHOT}"
	local current
	current="$(printf '%s\n' "${changed[@]}")"
	if [[ -f "${snapshot}" ]] && [[ "$(<"${snapshot}")" == "${current}" ]]; then
		log_line info "OK issue status snapshot unchanged (${#changed[@]} non-doing)"
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
		exit 0
	fi
	local snap_tmp
	if ! { snap_tmp="$(mktemp "${snapshot}.tmp.XXXXXX")" &&
		printf '%s\n' "${current}" >"${snap_tmp}" &&
		mv -f "${snap_tmp}" "${snapshot}"; }; then
		rm -f "${snap_tmp:-}"
		# The snapshot only suppresses duplicate digests; losing it costs one
		# repeated digest on the next run, so this stays informational.
		log_line info "snapshot update skipped: ${snapshot}"
	fi
	exit 0
}

main "$@"
