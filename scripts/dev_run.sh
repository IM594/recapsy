#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_SCRIPT="$ROOT_DIR/scripts/build_app.sh"
APP_NAME="${APP_NAME:-RecaplySense}"
APP_DIR="$ROOT_DIR/dist/${APP_NAME}.app"
APP_BIN="$APP_DIR/Contents/MacOS/$APP_NAME"
WATCH_INTERVAL="${WATCH_INTERVAL:-1}"
WATCH_MODE="${WATCH_MODE:-poll}"
LAUNCH_METHOD="${LAUNCH_METHOD:-open}"
SKIP_LAUNCH="${SKIP_LAUNCH:-0}"
BUILD_PROFILE="${BUILD_PROFILE:-debug-dev}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/dist/dev_run.log}"
APP_PID_FILE="${APP_PID_FILE:-$ROOT_DIR/dist/.dev_run.pid}"

usage() {
  cat <<EOF
usage: $0 [--once]

modes:
  (default)  watch source changes, rebuild, and relaunch app
  --once     perform one build+relaunch cycle and exit

env overrides:
  BUILD_PROFILE=debug-dev|debug|release   default: debug-dev
  WATCH_INTERVAL=<seconds>                default: 1
  WATCH_MODE=poll                         default: poll
  LAUNCH_METHOD=open|direct               default: open
  SKIP_LAUNCH=1                           build only, do not launch app
  APP_NAME=<name>                         default: RecaplySense
  LOG_FILE=<path>                         default: dist/dev_run.log

notes:
  1) This script uses polling and does not require watchexec/entr/fswatch.
  2) It only targets the app binary under dist/RecaplySense.app.
  3) LAUNCH_METHOD=open is recommended so macOS permissions bind to app identity.
EOF
}

if [[ ! -x "$BUILD_SCRIPT" ]]; then
  echo "[dev-run] build script not found or not executable: $BUILD_SCRIPT" >&2
  exit 1
fi

RUN_ONCE="0"
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
elif [[ "${1:-}" == "--once" ]]; then
  RUN_ONCE="1"
elif [[ $# -gt 0 ]]; then
  usage >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

ensure_app_pid_file_dir() {
  mkdir -p "$(dirname "$APP_PID_FILE")"
}

running_pid_from_file() {
  if [[ -f "$APP_PID_FILE" ]]; then
    local pid
    pid="$(cat "$APP_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

stop_tracked_app_process() {
  local tracked_pid
  if tracked_pid="$(running_pid_from_file)"; then
    echo "[dev-run] stopping tracked app pid=$tracked_pid"
    kill "$tracked_pid" 2>/dev/null || true
    sleep 0.3
    if kill -0 "$tracked_pid" 2>/dev/null; then
      kill -9 "$tracked_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$APP_PID_FILE"
}

stop_dist_app_processes() {
  local pids=""
  pids="$(pgrep -f "$APP_BIN" || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "[dev-run] stopping existing dist app process(es): $pids"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done <<< "$pids"
  sleep 0.3

  pids="$(pgrep -f "$APP_BIN" || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$pids"
  fi
}

launch_app() {
  if [[ "$SKIP_LAUNCH" == "1" ]]; then
    echo "[dev-run] SKIP_LAUNCH=1, skipping app launch"
    return 0
  fi

  if [[ "$LAUNCH_METHOD" == "open" ]]; then
    if [[ ! -d "$APP_DIR" ]]; then
      echo "[dev-run] app bundle not found: $APP_DIR" >&2
      return 1
    fi

    open -n "$APP_DIR"

    # Wait briefly until process appears, then persist pid for next restart cycle.
    local pid=""
    local _i
    for _i in {1..30}; do
      pid="$(pgrep -f "$APP_BIN" | tail -n 1 || true)"
      if [[ -n "$pid" ]]; then
        break
      fi
      sleep 0.1
    done

    ensure_app_pid_file_dir
    if [[ -n "$pid" ]]; then
      echo "$pid" > "$APP_PID_FILE"
      echo "[dev-run] launched $APP_NAME via open pid=$pid"
    else
      rm -f "$APP_PID_FILE"
      echo "[dev-run] launched $APP_NAME via open (pid not captured)"
    fi
    return 0
  fi

  if [[ "$LAUNCH_METHOD" == "direct" ]]; then
    if [[ ! -x "$APP_BIN" ]]; then
      echo "[dev-run] app binary not found: $APP_BIN" >&2
      return 1
    fi

    ensure_app_pid_file_dir
    nohup "$APP_BIN" >>"$LOG_FILE" 2>&1 &
    local pid="$!"
    echo "$pid" > "$APP_PID_FILE"
    echo "[dev-run] launched $APP_NAME via direct binary pid=$pid"
    return 0
  fi

  echo "[dev-run] unsupported LAUNCH_METHOD=$LAUNCH_METHOD (expected open|direct)" >&2
  return 1
}

build_app() {
  echo "[dev-run] building profile=$BUILD_PROFILE"
  "$BUILD_SCRIPT" "$BUILD_PROFILE"
}

build_and_restart() {
  if ! build_app; then
    echo "[dev-run] build failed; keep watching for next change" >&2
    return 1
  fi

  stop_tracked_app_process
  stop_dist_app_processes
  launch_app
}

watch_input_lines() {
  local roots=()
  local watch_root
  for watch_root in "$ROOT_DIR/Package.swift" "$ROOT_DIR/Sources" "$ROOT_DIR/scripts"; do
    if [[ -e "$watch_root" ]]; then
      roots+=("$watch_root")
    fi
  done

  if [[ "${#roots[@]}" -eq 0 ]]; then
    return 0
  fi

  find "${roots[@]}" -type f \
    \( -name "*.swift" -o -name "*.sh" -o -name "Package.swift" \) \
    -exec stat -f "%m %N" {} + 2>/dev/null | sort
}

watch_fingerprint() {
  local lines
  lines="$(watch_input_lines || true)"
  printf '%s\n' "$lines" | shasum | awk '{print $1}'
}

cleanup() {
  stop_tracked_app_process
}

if [[ "$RUN_ONCE" == "1" ]]; then
  build_and_restart
  exit 0
fi

if [[ "$WATCH_MODE" != "poll" ]]; then
  echo "[dev-run] unsupported WATCH_MODE=$WATCH_MODE, fallback to poll"
fi

trap cleanup INT TERM EXIT

echo "[dev-run] watching for changes every ${WATCH_INTERVAL}s"
echo "[dev-run] log file: $LOG_FILE"
build_and_restart || true

LAST_FINGERPRINT="$(watch_fingerprint)"
while true; do
  sleep "$WATCH_INTERVAL"
  CURRENT_FINGERPRINT="$(watch_fingerprint)"
  if [[ "$CURRENT_FINGERPRINT" != "$LAST_FINGERPRINT" ]]; then
    LAST_FINGERPRINT="$CURRENT_FINGERPRINT"
    echo "[dev-run] change detected, rebuilding..."
    build_and_restart || true
  fi
done
