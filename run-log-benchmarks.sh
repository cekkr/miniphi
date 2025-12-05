#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_ROOT="$ROOT_DIR/current-benchmarks"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
RUN_LOG="$RUN_DIR/run.log"
mkdir -p "$RUN_DIR"

log() {
  local message="$1"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf "[%s] %s\n" "$now" "$message" | tee -a "$RUN_LOG" >/dev/null
}

log_file_event() {
  local action="$1"
  local target="$2"
  local detail="$3"
  local action_upper
  action_upper="$(printf "%s" "$action" | tr '[:lower:]' '[:upper:]')"
  log "FILE ${action_upper}: ${target} (${detail})"
}

snapshot_workspace() {
  local destination="$1"
  log_file_event "write" "$destination" "git status snapshot"
  (cd "$ROOT_DIR" && git status --short --untracked=all) >"$destination" 2>&1 || true
}

normalize_label() {
  local label="$1"
  printf "%s" "$label" | tr ' /:' '_' | tr -cs 'A-Za-z0-9._-' '_'
}

copy_artifacts() {
  local status_file="$1"
  local artifact_dir="$2"
  mkdir -p "$artifact_dir"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" =~ ^# ]]; then
      continue
    fi
    local path="${line:3}"
    path="${path#" "}"
    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi
    local source="$ROOT_DIR/$path"
    local dest="$artifact_dir/$path"
    if [[ -f "$source" ]]; then
      mkdir -p "$(dirname "$dest")"
      cp "$source" "$dest"
      log_file_event "copy" "$dest" "snapshot of file $path"
    elif [[ -d "$source" ]]; then
      mkdir -p "$dest"
      rsync -a --delete "$source/" "$dest/"
      log_file_event "mirror" "$dest" "snapshot of directory $path"
    else
      log "WARN: referenced path '$path' no longer exists to copy."
    fi
  done <"$status_file"
}

record_changes() {
  local label="$1"
  local before="$2"
  local after="$3"
  local log_dir="$4"
  local diff_log="$log_dir/changes.diff"
  local before_sorted="$log_dir/before.sorted"
  local after_sorted="$log_dir/after.sorted"
  local added="$log_dir/added-status.log"
  local removed="$log_dir/removed-status.log"
  sort "$before" >"$before_sorted"
  sort "$after" >"$after_sorted"
  diff -u "$before_sorted" "$after_sorted" >"$diff_log" || true
  log_file_event "write" "$diff_log" "workspace diff for $label"
  comm -13 "$before_sorted" "$after_sorted" >"$added"
  comm -23 "$before_sorted" "$after_sorted" >"$removed"
  log_file_event "write" "$added" "new/modified paths for $label"
  log_file_event "write" "$removed" "removed paths for $label"
  if [[ -s "$added" ]]; then
    copy_artifacts "$added" "$log_dir/artifacts"
  else
    log "No new artifacts detected for $label."
  fi
}

run_command() {
  local label="$1"
  shift
  local -a cmd=("$@")
  local safe_label
  safe_label="$(normalize_label "$label")"
  local log_dir="$RUN_DIR/$safe_label"
  mkdir -p "$log_dir"
  log_file_event "mkdir" "$log_dir" "command log directory"
  local log_file="$log_dir/output.log"
  local before_state="$log_dir/before-status.log"
  local after_state="$log_dir/after-status.log"
  local exit_file="$log_dir/exit-code.txt"
  snapshot_workspace "$before_state"
  log "START [$label]: ${cmd[*]}"
  local exit_code=0
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "DRY_RUN=1 → skipping execution for $label."
  else
    set +e
    (
      cd "$ROOT_DIR"
      "${cmd[@]}"
    ) > >(tee "$log_file") 2>&1
    exit_code=$?
    set -e
  fi
  printf "%s\n" "$exit_code" >"$exit_file"
  log_file_event "write" "$log_file" "stdout/stderr for $label"
  log_file_event "write" "$exit_file" "exit code record for $label"
  snapshot_workspace "$after_state"
  record_changes "$label" "$before_state" "$after_state" "$log_dir"
  if [[ $exit_code -ne 0 ]]; then
    log "END [$label]: failed with exit code $exit_code"
  else
    log "END [$label]: completed successfully."
  fi
}

log "Benchmark capture root: $RUN_DIR"

RECOMPOSE_SAMPLE="${RECOMPOSE_SAMPLE:-samples/recompose/hello-flow}"
RECOMPOSE_MODE="${RECOMPOSE_MODE:-offline}"
IFS=',' read -r -a RECOMPOSE_DIRECTIONS <<<"${RECOMPOSE_DIRECTIONS:-code-to-markdown,markdown-to-code,roundtrip}"
log "Recompose sample: $RECOMPOSE_SAMPLE"
log "Recompose mode: $RECOMPOSE_MODE"

run_command "npm-sample-besh-journal" npm run sample:besh-journal

for direction in "${RECOMPOSE_DIRECTIONS[@]}"; do
  run_command "recompose-${direction}" \
    node src/index.js recompose \
    --sample "$RECOMPOSE_SAMPLE" \
    --direction "$direction" \
    --recompose-mode "$RECOMPOSE_MODE" \
    --prompt-journal "runlog-${direction}" \
    --prompt-journal-status "active" \
    --no-stream
done

run_command "npm-benchmark" npm run benchmark

log "Run complete. All logs available under $RUN_DIR"
