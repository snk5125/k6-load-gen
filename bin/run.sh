#!/bin/sh
# Container entrypoint. Runs k6, post-processes its sample stream into a
# compact timeline, ships artifacts to S3 (or a local directory), and exits
# with k6's own exit code.
#
# The k6 script makes no AWS calls and needs no credentials — only this
# wrapper touches S3. That is what keeps the ECS task role down to a single
# s3:PutObject action.
set -u

WORKDIR="${WORKDIR:-/tmp/k6run}"
RESULTS_URI="${RESULTS_URI:-}"
KEEP_RAW="${KEEP_RAW:-0}"
TIMELINE_BUCKET_SEC="${TIMELINE_BUCKET_SEC:-15}"
export TIMELINE_BUCKET_SEC
START_AT="${START_AT:-}"

# --- Scheduled start (START_AT). --------------------------------------------
#
# START_AT is either an ISO-8601 UTC timestamp (2026-09-05T14:00:00Z) or a
# Unix epoch in seconds. It exists so a multi-task fleet's tasks — which
# each launch independently via ECS RunTask and land on hosts at slightly
# different times — actually start generating load at (approximately) the
# same instant; src/fleet/launch.ts computes and injects it. It is honoured
# here, not there, because the skew it corrects for happens after the
# container starts.
#
# This script is POSIX sh with no GNU date guaranteed: the container image
# is Linux (GNU date, `date -u -d STRING`), but this wrapper's own test
# suite runs on macOS (BSD date, no -d; `-j -f INPUT_FMT STRING` instead).
# to_epoch tries the epoch and GNU forms first and only falls back to the
# BSD invocation when both fail, so neither platform pays for the other's
# fallback.
to_epoch() {
  ts=$1
  case "$ts" in
    *[!0-9]*)
      # ISO-8601 form.
      if epoch=$(date -u -d "$ts" +%s 2>/dev/null); then
        printf '%s\n' "$epoch"
        return 0
      fi
      date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$ts" +%s 2>/dev/null
      return $?
      ;;
    *)
      # Already a Unix epoch in seconds.
      printf '%s\n' "$ts"
      return 0
      ;;
  esac
}

# Sleeps in whole seconds until START_AT. A generator that starts after
# START_AT (clock already past it, or START_AT unparseable) logs why and
# proceeds immediately rather than blocking or failing the run — a
# scheduling miss must never turn into a lost run. Called once, before k6
# (or, in fleet mode, before any generator) starts, so every generator in a
# single-task fleet shares this exact wait instead of drifting apart.
wait_for_start_at() {
  [ -n "$START_AT" ] || return 0
  epoch=$(to_epoch "$START_AT")
  if [ -z "$epoch" ]; then
    echo "run.sh: could not parse START_AT=$START_AT (want ISO-8601 UTC or a Unix epoch in seconds); ignoring it" >&2
    return 0
  fi
  now=$(date -u +%s)
  delta=$((epoch - now))
  if [ "$delta" -le 0 ]; then
    echo "run.sh: START_AT was $((0 - delta)) s ago; starting immediately (late)" >&2
    return 0
  fi
  echo "run.sh: waiting ${delta}s for START_AT=$START_AT" >&2
  sleep "$delta"
}

# Overridable so the exact same wrapper runs in the container and in local
# development, where /app/dist (Task 5's build output) does not exist yet.
# In the image these default to the in-image paths; locally, point them at
# tsx running the TypeScript sources directly, e.g.:
#   K6_SCRIPT="$(pwd)/src/main.ts"
#   TIMELINE_CLI="$(pwd)/node_modules/.bin/tsx $(pwd)/src/timeline/cli.ts"
#   INDEX_CLI="$(pwd)/node_modules/.bin/tsx $(pwd)/src/storage/index-cli.ts"
#   PROFILE_DIR="$(pwd)/profiles"
#   FLEET_CLI="$(pwd)/node_modules/.bin/tsx $(pwd)/src/fleet/cli.ts"
# All four commands must be ABSOLUTE (see the note above `cd "$WORKDIR"`).
K6_SCRIPT="${K6_SCRIPT:-/app/src/main.ts}"
TIMELINE_CLI="${TIMELINE_CLI:-node /app/dist/timeline-cli.js}"
INDEX_CLI="${INDEX_CLI:-node /app/dist/index-cli.js}"
FLEET_CLI="${FLEET_CLI:-node /app/dist/fleet-cli.js}"
FLEET_LAUNCH_CLI="${FLEET_LAUNCH_CLI:-node /app/dist/fleet-launch.js}"

# --- Operator mode: `<image> fleet-launch ...` ------------------------------
#
# The same image doubles as the multi-task fleet launcher, run as a LOCAL
# container by the operator (docker run ... <image> fleet-launch run ...).
# Nothing below this block runs in that case: no WORKDIR, no k6, no
# shipping — the launcher talks to ECS and S3 with the credentials the
# operator handed the container, and exits with the fleet's verdict. This
# is the only argument the entrypoint interprets; a plain run takes none.
if [ "${1:-}" = "fleet-launch" ]; then
  shift
  # shellcheck disable=SC2086 # intentional word-splitting of the command
  exec $FLEET_LAUNCH_CLI "$@"
fi
PROFILE_DIR="${PROFILE_DIR:-/app/profiles}"

mkdir -p "$WORKDIR"
RAW="$WORKDIR/raw.json"
LOG="$WORKDIR/run.log"
SUMMARY="$WORKDIR/summary.json"
TIMELINE="$WORKDIR/timeline.jsonl"
INDEX="$WORKDIR/index.json"
FIFO="$WORKDIR/k6.fifo"

# --- Resolve EMIT_TIMELINE: environment, else profile, else 1. -------------
#
# Spec §9.1 makes `emit_timeline` a PROFILE flag ("on by default, off for
# extreme-rate runs"). It is validated by src/config/schema.ts and set by
# both shipped profiles, but until this block existed nothing read it: this
# wrapper looked only at the EMIT_TIMELINE environment variable, defaulting
# to 1, so `PROFILE=local-null` ran `--out json` despite its own profile
# saying not to. A validated-but-ignored knob is precisely the defect class
# spec §2.2 exists to eliminate.
#
# Precedence is ENVIRONMENT OVER PROFILE, matching every other setting in
# this project (TARGET, TYPES, <TYPE>_RATE, <TYPE>_SCENARIO, ... all
# override the profile via src/config/env.ts — a bare SCENARIO or RATE is
# no longer valid; see readOverrides' LEGACY_GLOBAL_OVERRIDES). An
# explicitly-set EMIT_TIMELINE therefore still wins over a profile that
# says false.
#
# `${EMIT_TIMELINE:+set}` — not `${EMIT_TIMELINE:-1}` — is what distinguishes
# "the operator chose a value" from "nobody set one", which is the whole
# point of the precedence rule.
#
# The profile value arrives as BARE FILE CONTENT through command
# substitution. Nothing here is eval'd or sourced; see the injection note in
# the s3:// branch below for why that shape is not negotiable.
if [ -n "${EMIT_TIMELINE:+set}" ]; then
  : # environment wins, whatever the profile says
else
  EMIT_TIMELINE=1
  PROFILE_JSON="$PROFILE_DIR/${PROFILE:-}.json"
  if [ -n "${PROFILE:-}" ] && [ -f "$PROFILE_JSON" ]; then
    # shellcheck disable=SC2086 # intentional word-splitting; INDEX_CLI must
    # not contain a space in any of its own path components.
    if PROFILE_EMIT_TIMELINE=$($INDEX_CLI emit-timeline "$PROFILE_JSON" 2>"$WORKDIR/emit_timeline.err"); then
      EMIT_TIMELINE="$PROFILE_EMIT_TIMELINE"
    else
      echo "run.sh: could not read emit_timeline from $PROFILE_JSON (see $WORKDIR/emit_timeline.err); defaulting to 1" >&2
    fi
  fi
fi

K6_ARGS="run $K6_SCRIPT"

# --- Single-task fleet mode. --------------------------------------------------
#
# GEN_COUNT=N with GEN_INDEX UNSET runs N k6 processes inside this one
# container (GEN_INDEX 0..N-1, each its own gen-<i>/ directory under
# WORKDIR) and merges their N summaries into ONE fleet summary via
# $FLEET_CLI (src/fleet/). GEN_INDEX set — to anything — means the operator
# is running one generator per task, the multi-task fleet, and this script
# behaves exactly as it always has. A non-numeric GEN_COUNT is left for k6
# to reject at init (exit 107) as before.
#
# Capacity is bounded by one task: N k6 processes share its CPUs. This mode
# exists for generator IDENTITY (run_id, gen_index, seq on the wire) and for
# one launch / one artifact set, not for scaling past a single task.
FLEET=0
case "${GEN_COUNT:-}" in
  ''|*[!0-9]*) ;;
  *) if [ "$GEN_COUNT" -gt 1 ] && [ -z "${GEN_INDEX+set}" ]; then FLEET=1; fi ;;
esac

# --- Artifact shipping, with accounting. -----------------------------------
#
# Every individual failure below is non-fatal on purpose: an upload must
# never mask the run's verdict (exit 99 is the CI gate). But "non-fatal" was
# previously indistinguishable from "fine" — three separate paths could
# persist NOTHING and still exit with k6's own code and no aggregate signal:
# an unparseable started_at, a missing summary.json, and a total upload
# failure swallowed by `|| true`. The counters below give shipping its own
# signal without touching the exit code.
SHIPPED_OK=0
SHIPPED_FAILED=0
SHIP_SKIP_REASON=""

# Ships one artifact and records the outcome. ALWAYS returns 0 — the caller
# must never be able to abort a run on a shipping failure.
ship() {
  if "$@"; then
    SHIPPED_OK=$((SHIPPED_OK + 1))
  else
    SHIPPED_FAILED=$((SHIPPED_FAILED + 1))
  fi
  return 0
}

# ship_s3_dir DIR IDENTITY_SUMMARY [GEN_INDEX]
#
# Uploads whatever artifacts exist in DIR (summary.json, run.log,
# timeline.jsonl, raw.json as .gz when KEEP_RAW=1) to the spec §9.3 keys
# derived from IDENTITY_SUMMARY. Normally that is DIR's own summary.json; in
# fleet mode a generator that crashed before writing one has its keys derived
# from the FLEET summary with GEN_INDEX overriding the generator identity, so
# its run.log — the most useful artifact of a partial failure — still lands
# under runs/<run_id>/gen-<i>/. index.json is derived from DIR's own summary
# and shipped only when that summary exists.
#
# index-cli throws on a malformed run_id or an unparseable started_at
# (see src/storage/keys.ts: artifactKeys / partitionDate). That is a
# real run-time condition, not a wrapper bug, and it must not become
# fatal here: uploads are best-effort and must never mask k6's own
# exit code. It IS counted — see SHIP_SKIP_REASON.
#
# KEYS ARE NEVER SOURCED OR EVAL'D. An earlier version of this script
# had index-cli print `KEY_X='...'` shell assignments and `.`-sourced
# them — run_id (which reaches index-cli via the RUN_ID env var) was
# embedded inside shell syntax, so a run_id containing a single quote
# could inject arbitrary commands into the one process holding this
# task's S3-write credentials. index-cli's `keys` mode now writes each
# key to its own file, and `$(cat file)` below is command substitution
# of file CONTENT — it is never interpreted as shell syntax, no matter
# what bytes the file holds. (artifactKeys also now allowlists
# run_id — belt and braces — but this shape doesn't depend on that
# allowlist being complete.)
ship_s3_dir() {
  DIR=$1
  IDENTITY=$2
  GEN_OVERRIDE=${3:-}
  KEYDIR="$DIR/keys"
  rm -rf "$KEYDIR"
  # shellcheck disable=SC2086 # intentional word-splitting; INDEX_CLI
  # must not contain a space in any of its own path components.
  if ! $INDEX_CLI keys "$PREFIX" "$KEYDIR" $GEN_OVERRIDE < "$IDENTITY" 2>"$DIR/index_cli_keys.err"; then
    SHIP_SKIP_REASON="index-cli could not derive S3 keys from summary.json (see $DIR/index_cli_keys.err)"
    echo "run.sh: index-cli could not derive S3 keys (see $DIR/index_cli_keys.err); skipping S3 upload of $DIR" >&2
    return 0
  fi
  KEY_INDEX=$(cat "$KEYDIR/index")
  KEY_TIMELINE=$(cat "$KEYDIR/timeline")
  KEY_SUMMARY=$(cat "$KEYDIR/summary")
  KEY_RUN_LOG=$(cat "$KEYDIR/run_log")
  KEY_RAW=$(cat "$KEYDIR/raw")
  KEY_EXIT_CODE=$(cat "$KEYDIR/exit_code")

  if [ -f "$DIR/summary.json" ]; then
    # shellcheck disable=SC2086
    if $INDEX_CLI index < "$DIR/summary.json" > "$DIR/index.json" 2>"$DIR/index_cli_index.err"; then
      ship aws s3 cp "$DIR/index.json" "s3://$BUCKET/$KEY_INDEX" --only-show-errors
    else
      SHIPPED_FAILED=$((SHIPPED_FAILED + 1))
      echo "run.sh: index-cli could not build the flat index record (see $DIR/index_cli_index.err)" >&2
    fi
    ship aws s3 cp "$DIR/summary.json" "s3://$BUCKET/$KEY_SUMMARY" --only-show-errors
  fi
  [ -f "$DIR/run.log" ] && ship aws s3 cp "$DIR/run.log" "s3://$BUCKET/$KEY_RUN_LOG" --only-show-errors
  [ -f "$DIR/exit_code" ] && ship aws s3 cp "$DIR/exit_code" "s3://$BUCKET/$KEY_EXIT_CODE" --only-show-errors
  [ -f "$DIR/timeline.jsonl" ] && ship aws s3 cp "$DIR/timeline.jsonl" "s3://$BUCKET/$KEY_TIMELINE" --only-show-errors
  if [ "$KEEP_RAW" = "1" ] && [ -f "$DIR/raw.json" ]; then
    gzip -c "$DIR/raw.json" > "$DIR/raw.json.gz"
    ship aws s3 cp "$DIR/raw.json.gz" "s3://$BUCKET/$KEY_RAW" --only-show-errors
  fi
  return 0
}

# ship_local_dir SRC DEST
#
# A filesystem RESULTS_URI. This is NOT the same code path as ship_s3_dir,
# and the differences are deliberate: it derives no artifact keys, writes no
# index.json at all, and flattens every file into one directory instead of
# the date-partitioned §9.3 layout. It exists for local runs and the
# integration rig, where a flat directory is what a human actually wants to
# open. (In fleet mode DEST is a gen-<i>/ or fleet/ subdirectory of
# RESULTS_URI, so the generators do not overwrite each other.)
#
# This comment used to claim the two branches were "the identical code
# path with the upload replaced by a copy". They never were, and that
# false claim is what concealed KEEP_RAW being a silent no-op for every
# local RESULTS_URI (found in Task 7, fixed, and now regression-tested).
# Anything added to the s3:// branch must be added here deliberately —
# nothing about this branch comes for free.
ship_local_dir() {
  SRC=$1
  DEST=$2
  mkdir -p "$DEST"
  [ -f "$SRC/summary.json" ] && ship cp "$SRC/summary.json" "$DEST/"
  [ -f "$SRC/run.log" ] && ship cp "$SRC/run.log" "$DEST/"
  [ -f "$SRC/exit_code" ] && ship cp "$SRC/exit_code" "$DEST/"
  [ -f "$SRC/timeline.jsonl" ] && ship cp "$SRC/timeline.jsonl" "$DEST/"
  if [ "$KEEP_RAW" = "1" ] && [ -f "$SRC/raw.json" ]; then
    gzip -c "$SRC/raw.json" > "$SRC/raw.json.gz"
    ship cp "$SRC/raw.json.gz" "$DEST/"
  fi
  return 0
}

# Every other skipped/failed step below logs to stderr; an unset RESULTS_URI
# was the one silent exception — a platform team that forgets to set it got
# no signal at all and simply never saw artifacts appear anywhere.
if [ -z "$RESULTS_URI" ]; then
  SHIP_SKIP_REASON="RESULTS_URI is not set; artifacts remain in $WORKDIR"
  echo "run.sh: RESULTS_URI is not set; artifacts remain in $WORKDIR and were not shipped anywhere" >&2
fi

# ECS injects NO region (unlike Lambda), and a Fargate awsvpc task has no
# reachable IMDS for the CLI to fall back on — so `aws s3 cp` fails region
# resolution outright. Combined with shipping being non-fatal, the failure
# mode is a green run that persists nothing. Warn loudly; do not exit.
case "$RESULTS_URI" in
  s3://*)
    BUCKET=$(echo "$RESULTS_URI" | sed -e 's|^s3://||' -e 's|/.*$||')
    PREFIX=$(echo "$RESULTS_URI" | sed -e 's|^s3://[^/]*||' -e 's|^/||')
    if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
      echo "run.sh: RESULTS_URI is an s3:// URI but neither AWS_REGION nor AWS_DEFAULT_REGION is set — ECS does not inject a region and Fargate awsvpc tasks cannot reach IMDS, so every 'aws s3 cp' below will fail region resolution and nothing will be persisted" >&2
    fi
    ;;
esac

# Prints the one aggregate shipping line, always. Three total-artifact-loss
# modes used to be visible only as scattered stderr text or not at all;
# anything reading this run now gets a single summary of what was persisted.
report_shipping() {
  SHIPPED_TOTAL=$((SHIPPED_OK + SHIPPED_FAILED))
  if [ "$SHIPPED_TOTAL" -eq 0 ]; then
    echo "run.sh: 0 artifacts shipped — ${SHIP_SKIP_REASON:-nothing to ship}" >&2
  elif [ "$SHIPPED_FAILED" -gt 0 ]; then
    echo "run.sh: $SHIPPED_FAILED of $SHIPPED_TOTAL artifacts failed to upload to $RESULTS_URI" >&2
  else
    echo "run.sh: $SHIPPED_OK of $SHIPPED_TOTAL artifacts shipped to $RESULTS_URI" >&2
  fi
}

# =============================================================================
# FLEET MODE
# =============================================================================
if [ "$FLEET" = "1" ]; then
  NCPU=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
  if [ "$NCPU" -gt 0 ] && [ "$GEN_COUNT" -gt "$NCPU" ]; then
    echo "run.sh: $GEN_COUNT generators on $NCPU CPUs — k6 is CPU-bound, so they will contend and may drop iterations (which voids the run); prefer GEN_COUNT <= CPUs or a multi-task fleet" >&2
  fi

  # Waited ONCE, here, before any generator is spawned — so all N share the
  # same start rather than each computing (and drifting from) its own.
  wait_for_start_at

  # One k6 process per generator, each in its own directory (k6 writes
  # summary.json relative to its cwd, so the subshell's cd is what keeps
  # the N summaries apart). The exit code is written to a file from INSIDE
  # the first stage of the pipeline, so the pipeline's own status — which
  # POSIX sh reports as the LAST command's — never matters. Output lines
  # are tagged [gen-<i>] because N processes interleave on the container
  # log; the while-read loop (not sed) keeps them line-buffered so the log
  # stays live.
  i=0
  while [ "$i" -lt "$GEN_COUNT" ]; do
    GENDIR="$WORKDIR/gen-$i"
    mkdir -p "$GENDIR"
    GEN_ARGS="$K6_ARGS"
    if [ "$EMIT_TIMELINE" = "1" ]; then
      GEN_ARGS="$GEN_ARGS --out json=$GENDIR/raw.json"
    fi
    (
      cd "$GENDIR" || exit 1
      # shellcheck disable=SC2086 # intentional word-splitting of flags
      { GEN_INDEX=$i k6 $GEN_ARGS 2>&1; echo $? > exit_code; } |
        while IFS= read -r line; do printf '[gen-%s] %s\n' "$i" "$line"; done |
        tee run.log
      if [ "$EMIT_TIMELINE" = "1" ] && [ -f raw.json ]; then
        # shellcheck disable=SC2086
        if ! $TIMELINE_CLI < raw.json > timeline.jsonl 2>timeline_cli.err; then
          echo "run.sh: [gen-$i] timeline generation failed (see $GENDIR/timeline_cli.err); continuing without it" >&2
          rm -f timeline.jsonl
        fi
      fi
    ) &
    i=$((i + 1))
  done
  wait

  # Container exit code — explicit precedence, not a numeric max. The SAME
  # rule is implemented by fleetExitCode in src/fleet/merge.ts and carried
  # on the fleet summary as fleet.exit_code (for multi-task orchestrators
  # that merge downloaded generator directories); the wrapper keeps its own
  # copy only because it must still exit correctly when the merge itself
  # fails. tests/wrapper/run-sh.test.ts asserts the two agree.
  #   any non-zero code other than 99 (a crash, a config error, a kill) beats
  #   99, because a generator that never ran means the fleet's numbers are
  #   not a measurement at all, which must not be downgraded to "thresholds
  #   failed"; 99 beats 0; among crash codes the lowest generator index wins.
  FLEET_EXIT=0
  i=0
  while [ "$i" -lt "$GEN_COUNT" ]; do
    GENDIR="$WORKDIR/gen-$i"
    if [ -f "$GENDIR/exit_code" ]; then
      CODE=$(cat "$GENDIR/exit_code")
    else
      CODE=1
      echo "run.sh: [gen-$i] recorded no exit code — treating as failure" >&2
      echo 1 > "$GENDIR/exit_code"
    fi
    case "$CODE" in ''|*[!0-9]*) CODE=1 ;; esac
    # Same rule as single mode: a claimed success with no summary is a failure.
    if [ "$CODE" -eq 0 ] && [ ! -f "$GENDIR/summary.json" ]; then
      echo "run.sh: [gen-$i] k6 exited 0 but produced no summary.json — treating as failure" >&2
      CODE=1
      echo 1 > "$GENDIR/exit_code"
    fi
    if [ "$CODE" -ne 0 ]; then
      if [ "$CODE" -ne 99 ]; then
        if [ "$FLEET_EXIT" -eq 0 ] || [ "$FLEET_EXIT" -eq 99 ]; then FLEET_EXIT=$CODE; fi
      elif [ "$FLEET_EXIT" -eq 0 ]; then
        FLEET_EXIT=99
      fi
    fi
    i=$((i + 1))
  done

  # Merge. The report goes to fleet/run.log and then to the container log;
  # a failed merge is loud but never fatal — the per-generator artifacts are
  # still shipped below, and the exit code stays k6's.
  FLEETDIR="$WORKDIR/fleet"
  mkdir -p "$FLEETDIR"
  GENDIRS=""
  i=0
  while [ "$i" -lt "$GEN_COUNT" ]; do
    GENDIRS="$GENDIRS $WORKDIR/gen-$i"
    i=$((i + 1))
  done
  # shellcheck disable=SC2086 # intentional word-splitting of FLEET_CLI and GENDIRS
  if $FLEET_CLI merge "$FLEETDIR" $GENDIRS > "$FLEETDIR/run.log" 2>"$FLEETDIR/fleet_cli.err"; then
    cat "$FLEETDIR/run.log"
  else
    echo "run.sh: fleet merge failed (see $FLEETDIR/fleet_cli.err); per-generator artifacts are still shipped" >&2
    cat "$FLEETDIR/fleet_cli.err" >&2
  fi
  FLEET_SUMMARY="$FLEETDIR/summary.json"

  if [ -n "$RESULTS_URI" ]; then
    case "$RESULTS_URI" in
      s3://*)
        i=0
        while [ "$i" -lt "$GEN_COUNT" ]; do
          GENDIR="$WORKDIR/gen-$i"
          if [ -f "$GENDIR/summary.json" ]; then
            ship_s3_dir "$GENDIR" "$GENDIR/summary.json"
          elif [ -f "$FLEET_SUMMARY" ]; then
            ship_s3_dir "$GENDIR" "$FLEET_SUMMARY" "$i"
          else
            SHIP_SKIP_REASON="gen-$i produced no summary.json and no fleet summary exists to derive keys from"
            echo "run.sh: [gen-$i] no summary.json and no fleet summary — cannot derive artifact keys; its run.log was not shipped" >&2
          fi
          i=$((i + 1))
        done
        if [ -f "$FLEET_SUMMARY" ]; then
          ship_s3_dir "$FLEETDIR" "$FLEET_SUMMARY"
        fi
        ;;
      *)
        i=0
        while [ "$i" -lt "$GEN_COUNT" ]; do
          ship_local_dir "$WORKDIR/gen-$i" "$RESULTS_URI/gen-$i"
          i=$((i + 1))
        done
        ship_local_dir "$FLEETDIR" "$RESULTS_URI/fleet"
        ;;
    esac
  fi

  report_shipping
  exit "$FLEET_EXIT"
fi

# =============================================================================
# SINGLE-GENERATOR MODE (the original path, unchanged in behaviour)
# =============================================================================
if [ "$EMIT_TIMELINE" = "1" ]; then
  # --out json costs throughput at very high rates; EMIT_TIMELINE=0 disables it.
  K6_ARGS="$K6_ARGS --out json=$RAW"
fi

# k6's handleSummary writes 'summary.json' relative to the process cwd, so
# this cd is load-bearing: $SUMMARY above must resolve to the same file k6
# wrote. That is also why K6_SCRIPT/TIMELINE_CLI/INDEX_CLI must be absolute:
# a relative override would stop resolving correctly the moment we cd.
cd "$WORKDIR" || exit 1

wait_for_start_at

# --- Run k6, capturing its OWN exit status while still streaming its
# output to the container log in real time. --------------------------------
#
# The naive `k6 ... | tee "$LOG"` loses k6's exit status: $? after a
# pipeline is the LAST command's status (tee's), not k6's, and
# `set -o pipefail` is a bashism this POSIX-sh script cannot use. Instead of
# putting k6 in a pipeline at all, it writes to a named pipe; a background
# `tee` drains that pipe to both the log file and this script's own stdout;
# and we read $? immediately after the (unpiped) k6 command — the one and
# only place this script trusts as k6's exit status.
rm -f "$FIFO"
mkfifo "$FIFO" || { echo "run.sh: mkfifo failed" >&2; exit 1; }

tee "$LOG" < "$FIFO" &
TEE_PID=$!

# shellcheck disable=SC2086 # intentional word-splitting of flags; K6_SCRIPT
# (and RAW) must therefore not contain a space, or it will mis-split here.
k6 $K6_ARGS > "$FIFO" 2>&1
K6_EXIT=$?

# k6 closing its end of the fifo is what lets `tee` see EOF and exit; wait
# for it so $LOG is fully flushed before anything below reads it.
wait "$TEE_PID"
rm -f "$FIFO"

# A summary.json means handleSummary ran, which k6 does even on a threshold
# breach (that is how exit 99 still carries a report). Its absence despite a
# reported success is the one case k6's own exit code can't be trusted, so
# this only overrides K6_EXIT when k6 claimed success — a genuine non-zero
# k6 failure reaches the final `exit` below untouched.
if [ "$K6_EXIT" -eq 0 ] && [ ! -f "$SUMMARY" ]; then
  echo "run.sh: k6 exited 0 but produced no summary.json — treating as failure" >&2
  K6_EXIT=1
fi
# Shipped beside summary.json so a fleet merged later from S3 (fleet-launch)
# knows how this generator ended; the summary is written by k6 before the
# code exists. Fleet mode writes the same file per generator directory.
printf '%s\n' "$K6_EXIT" > "$WORKDIR/exit_code"

if [ "$EMIT_TIMELINE" = "1" ] && [ -f "$RAW" ]; then
  # shellcheck disable=SC2086 # intentional word-splitting; TIMELINE_CLI must
  # not contain a space in any of its own path components.
  if ! $TIMELINE_CLI < "$RAW" > "$TIMELINE" 2>"$WORKDIR/timeline_cli.err"; then
    echo "run.sh: timeline generation failed (see $WORKDIR/timeline_cli.err); continuing without it" >&2
    rm -f "$TIMELINE"
  fi
fi

if [ -n "$RESULTS_URI" ] && [ ! -f "$SUMMARY" ]; then
  # Without summary.json there is no run identity to derive keys from, so
  # not even run.log can be placed. Previously this fell through the `-f`
  # guard below in complete silence.
  SHIP_SKIP_REASON="no summary.json was produced, so no run identity could be derived"
  echo "run.sh: no summary.json in $WORKDIR — cannot derive artifact keys; nothing was shipped to $RESULTS_URI" >&2
fi

if [ -n "$RESULTS_URI" ] && [ -f "$SUMMARY" ]; then
  case "$RESULTS_URI" in
    s3://*) ship_s3_dir "$WORKDIR" "$SUMMARY" ;;
    *)      ship_local_dir "$WORKDIR" "$RESULTS_URI" ;;
  esac
fi

report_shipping

# Uploads must never mask the run's verdict: exit 99 is the CI gate.
exit "$K6_EXIT"
