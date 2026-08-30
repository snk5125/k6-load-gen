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

# Overridable so the exact same wrapper runs in the container and in local
# development, where /app/dist (Task 5's build output) does not exist yet.
# In the image these default to the in-image paths; locally, point them at
# tsx running the TypeScript sources directly, e.g.:
#   K6_SCRIPT="$(pwd)/src/main.ts"
#   TIMELINE_CLI="$(pwd)/node_modules/.bin/tsx $(pwd)/src/timeline/cli.ts"
#   INDEX_CLI="$(pwd)/node_modules/.bin/tsx $(pwd)/src/storage/index-cli.ts"
#   PROFILE_DIR="$(pwd)/profiles"
# All three commands must be ABSOLUTE (see the note above `cd "$WORKDIR"`).
K6_SCRIPT="${K6_SCRIPT:-/app/src/main.ts}"
TIMELINE_CLI="${TIMELINE_CLI:-node /app/dist/timeline-cli.js}"
INDEX_CLI="${INDEX_CLI:-node /app/dist/index-cli.js}"
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
# this project (TARGET, SCENARIO, RATE, ... all override the profile via
# src/config/env.ts). An explicitly-set EMIT_TIMELINE therefore still wins
# over a profile that says false.
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
if [ "$EMIT_TIMELINE" = "1" ]; then
  # --out json costs throughput at very high rates; EMIT_TIMELINE=0 disables it.
  K6_ARGS="$K6_ARGS --out json=$RAW"
fi

# k6's handleSummary writes 'summary.json' relative to the process cwd, so
# this cd is load-bearing: $SUMMARY above must resolve to the same file k6
# wrote. That is also why K6_SCRIPT/TIMELINE_CLI/INDEX_CLI must be absolute:
# a relative override would stop resolving correctly the moment we cd.
cd "$WORKDIR" || exit 1

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

if [ "$EMIT_TIMELINE" = "1" ] && [ -f "$RAW" ]; then
  # shellcheck disable=SC2086 # intentional word-splitting; TIMELINE_CLI must
  # not contain a space in any of its own path components.
  if ! $TIMELINE_CLI < "$RAW" > "$TIMELINE" 2>"$WORKDIR/timeline_cli.err"; then
    echo "run.sh: timeline generation failed (see $WORKDIR/timeline_cli.err); continuing without it" >&2
    rm -f "$TIMELINE"
  fi
fi

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
    if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
      echo "run.sh: RESULTS_URI is an s3:// URI but neither AWS_REGION nor AWS_DEFAULT_REGION is set — ECS does not inject a region and Fargate awsvpc tasks cannot reach IMDS, so every 'aws s3 cp' below will fail region resolution and nothing will be persisted" >&2
    fi
    ;;
esac

if [ -n "$RESULTS_URI" ] && [ ! -f "$SUMMARY" ]; then
  # Without summary.json there is no run identity to derive keys from, so
  # not even run.log can be placed. Previously this fell through the `-f`
  # guard below in complete silence.
  SHIP_SKIP_REASON="no summary.json was produced, so no run identity could be derived"
  echo "run.sh: no summary.json in $WORKDIR — cannot derive artifact keys; nothing was shipped to $RESULTS_URI" >&2
fi

if [ -n "$RESULTS_URI" ] && [ -f "$SUMMARY" ]; then
  case "$RESULTS_URI" in
    s3://*)
      BUCKET=$(echo "$RESULTS_URI" | sed -e 's|^s3://||' -e 's|/.*$||')
      PREFIX=$(echo "$RESULTS_URI" | sed -e 's|^s3://[^/]*||' -e 's|^/||')

      # index-cli throws on a malformed run_id or an unparseable started_at
      # (see src/storage/keys.ts: artifactKeys / partitionDate). That is a
      # real run-time condition, not a wrapper bug, and it must not become
      # fatal here: uploads are best-effort and must never mask k6's own
      # exit code. It IS now counted — see SHIP_SKIP_REASON.
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
      KEYDIR="$WORKDIR/keys"
      rm -rf "$KEYDIR"
      KEYS_OK=1
      # shellcheck disable=SC2086 # intentional word-splitting; INDEX_CLI
      # must not contain a space in any of its own path components.
      if $INDEX_CLI keys "$PREFIX" "$KEYDIR" < "$SUMMARY" 2>"$WORKDIR/index_cli_keys.err"; then
        KEY_INDEX=$(cat "$KEYDIR/index")
        KEY_TIMELINE=$(cat "$KEYDIR/timeline")
        KEY_SUMMARY=$(cat "$KEYDIR/summary")
        KEY_RUN_LOG=$(cat "$KEYDIR/run_log")
        KEY_RAW=$(cat "$KEYDIR/raw")
      else
        KEYS_OK=0
        SHIP_SKIP_REASON="index-cli could not derive S3 keys from summary.json (see $WORKDIR/index_cli_keys.err)"
        echo "run.sh: index-cli could not derive S3 keys (see $WORKDIR/index_cli_keys.err); skipping S3 upload" >&2
      fi

      if [ "$KEYS_OK" = "1" ]; then
        # shellcheck disable=SC2086
        if $INDEX_CLI index < "$SUMMARY" > "$INDEX" 2>"$WORKDIR/index_cli_index.err"; then
          ship aws s3 cp "$INDEX" "s3://$BUCKET/$KEY_INDEX" --only-show-errors
        else
          SHIPPED_FAILED=$((SHIPPED_FAILED + 1))
          echo "run.sh: index-cli could not build the flat index record (see $WORKDIR/index_cli_index.err)" >&2
        fi

        ship aws s3 cp "$SUMMARY" "s3://$BUCKET/$KEY_SUMMARY" --only-show-errors
        ship aws s3 cp "$LOG" "s3://$BUCKET/$KEY_RUN_LOG" --only-show-errors
        [ -f "$TIMELINE" ] && ship aws s3 cp "$TIMELINE" "s3://$BUCKET/$KEY_TIMELINE" --only-show-errors
        if [ "$KEEP_RAW" = "1" ] && [ -f "$RAW" ]; then
          gzip -c "$RAW" > "$RAW.gz"
          ship aws s3 cp "$RAW.gz" "s3://$BUCKET/$KEY_RAW" --only-show-errors
        fi
      fi
      ;;
    *)
      # A filesystem path. This is NOT the same code path as the s3:// branch
      # above, and the differences are deliberate: it derives no artifact
      # keys, writes no index.json at all, and flattens every file into one
      # directory instead of the date-partitioned §9.3 layout. It exists for
      # local runs and the integration rig, where a flat directory is what a
      # human actually wants to open.
      #
      # This comment used to claim the two branches were "the identical code
      # path with the upload replaced by a copy". They never were, and that
      # false claim is what concealed KEEP_RAW being a silent no-op for every
      # local RESULTS_URI (found in Task 7, fixed, and now regression-tested).
      # Anything added to the s3:// branch must be added here deliberately —
      # nothing about this branch comes for free.
      mkdir -p "$RESULTS_URI"
      ship cp "$SUMMARY" "$RESULTS_URI/"
      ship cp "$LOG" "$RESULTS_URI/"
      [ -f "$TIMELINE" ] && ship cp "$TIMELINE" "$RESULTS_URI/"
      if [ "$KEEP_RAW" = "1" ] && [ -f "$RAW" ]; then
        gzip -c "$RAW" > "$RAW.gz"
        ship cp "$RAW.gz" "$RESULTS_URI/"
      fi
      ;;
  esac
fi

# One aggregate line, always. Three total-artifact-loss modes used to be
# visible only as scattered stderr text or not at all; anything reading this
# run now gets a single summary of what was persisted.
SHIPPED_TOTAL=$((SHIPPED_OK + SHIPPED_FAILED))
if [ "$SHIPPED_TOTAL" -eq 0 ]; then
  echo "run.sh: 0 artifacts shipped — ${SHIP_SKIP_REASON:-nothing to ship}" >&2
elif [ "$SHIPPED_FAILED" -gt 0 ]; then
  echo "run.sh: $SHIPPED_FAILED of $SHIPPED_TOTAL artifacts failed to upload to $RESULTS_URI" >&2
else
  echo "run.sh: $SHIPPED_OK of $SHIPPED_TOTAL artifacts shipped to $RESULTS_URI" >&2
fi

# Uploads must never mask the run's verdict: exit 99 is the CI gate.
exit "$K6_EXIT"
