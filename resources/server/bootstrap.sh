#!/bin/bash
# Obsidian Code GPU server bootstrap (runs inside the Vast.ai instance; started by onstart.sh).
#
#   bootstrap.sh main            first start: pick the model (current_model or $OC_MODEL_ID) and serve it
#   bootstrap.sh serve <modelId> download (if needed) + start + supervise llama-server
#   bootstrap.sh switch <modelId> stop the current server and serve another catalog model (used by switch.sh)
#
# State lives in /root/oc (env, config.sh, status.json, server.log, heartbeat, *.pid); models in /root/models/<id>.
# OC_ROOT (default /root) relocates both, for tests only.
# The self-destroy watchdog is armed by onstart.sh before this script runs. Everything is logged to /root/oc/server.log.
set -u
R=${OC_ROOT:-/root}
OC=$R/oc
MODELS=$R/models
LOG=$OC/server.log
mkdir -p "$OC" "$MODELS"
cd "$OC" || exit 1
[ -f "$OC/env" ] && . "$OC/env"
OC_EXTRA=()
LOAD_MAX_MIN=25
[ -f "$OC/config.sh" ] && . "$OC/config.sh"
LLAMA_BIN=/app/llama-server
[ -x "$LLAMA_BIN" ] || LLAMA_BIN=$(command -v llama-server 2>/dev/null || echo /app/llama-server)

# Detached background start (own process group when setsid exists; procps/pkill are not assumed to exist).
bg() { if command -v setsid >/dev/null; then setsid nohup "$@"; else nohup "$@"; fi; }

log() { echo "[$(date -u +%FT%TZ)] [oc] $*" >> "$LOG"; }
jesc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\r'/}; s=${s//$'\t'/ }; printf '%s' "$s"; }
frac() { awk -v d="$1" -v t="$2" 'BEGIN { if (t > 0) { p = d / t; if (p > 1) p = 1; printf "%.4f", p } else printf "0" }'; }
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1e9 }'; }
# status <phase> <progress> <message> <modelId> <bytesDone> <bytesTotal>
status() {
  printf '{"phase":"%s","progress":%s,"message":"%s","modelId":"%s","bytesDone":%s,"bytesTotal":%s,"updatedAt":%s}\n' \
    "$1" "${2:-0}" "$(jesc "${3:-}")" "$(jesc "${4:-}")" "${5:-0}" "${6:-0}" "$(date +%s)" > "$OC/status.json.tmp" \
    && mv -f "$OC/status.json.tmp" "$OC/status.json"
}
fail() { log "ERROR: $2"; status error 0 "$2" "$1" 0 0; rm -f "$OC/busy"; exit 1; }
dir_bytes() { du -sb "$1" 2>/dev/null | awk '{ print $1 + 0 }'; }
free_bytes() { df -B1 --output=avail "$MODELS" 2>/dev/null | tail -n1 | tr -d ' '; }

model_files() {
  FILES=("${M_FILES[@]}")
  if [ -n "${M_MMPROJ:-}" ]; then FILES+=("$M_MMPROJ"); fi
}

ensure_hf() {
  if command -v hf >/dev/null 2>&1 && [ -f "$OC/.hf_ok" ]; then return 0; fi
  log "installing huggingface_hub[hf_xet]"
  if python3 -m pip install -q --break-system-packages -U "huggingface_hub[hf_xet]" >> "$LOG" 2>&1 \
     || python3 -m pip install -q -U "huggingface_hub[hf_xet]" >> "$LOG" 2>&1; then
    hash -r
    if command -v hf >/dev/null 2>&1; then touch "$OC/.hf_ok"; return 0; fi
  fi
  log "hf CLI unavailable; falling back to curl"
  return 1
}

ensure_space() { # <modelId>
  local avail need have d
  avail=$(free_bytes)
  [ -n "$avail" ] || return 0
  have=$(dir_bytes "$MODELS/$1"); have=${have:-0}
  need=$(( M_BYTES - have + 2000000000 ))
  if [ "$avail" -lt "$need" ]; then
    log "low disk ($(gb "$avail") GB free, need $(gb "$need") GB): removing other models"
    for d in "$MODELS"/*/; do
      [ -d "$d" ] || continue
      [ "${d%/}" = "$MODELS/$1" ] || rm -rf "$d"
    done
    avail=$(free_bytes)
    [ "${avail:-0}" -lt "$need" ] && fail "$1" "Not enough disk for $1: need $(gb "$need") GB, free $(gb "${avail:-0}") GB"
  fi
  return 0
}

progress_loop() { # <modelId> <dir> <totalBytes>
  local d
  while :; do
    d=$(dir_bytes "$2"); d=${d:-0}
    [ "$d" -gt "$3" ] && d=$3
    status downloading "$(frac "$d" "$3")" "Downloading $1: $(gb "$d") / $(gb "$3") GB" "$1" "$d" "$3"
    sleep 3
  done
}

download_model() { # <modelId>
  local id=$1 dir=$MODELS/$1 ok=0 try pl f p
  if [ -f "$dir/.oc_complete" ]; then log "model $id already on disk"; return 0; fi
  mkdir -p "$dir"
  ensure_space "$id"
  model_files
  status downloading 0 "Preparing download of $id" "$id" 0 "$M_BYTES"
  ensure_hf; local have_hf=$?
  progress_loop "$id" "$dir" "$M_BYTES" &
  pl=$!
  if [ $have_hf = 0 ]; then
    for try in 1 2 3; do
      log "hf download $M_REPO (${#FILES[@]} files) try $try"
      if HF_HUB_DISABLE_PROGRESS_BARS=1 HF_XET_HIGH_PERFORMANCE=1 hf download "$M_REPO" "${FILES[@]}" --local-dir "$dir" --max-workers 16 >> "$LOG" 2>&1; then
        ok=1; break
      fi
      sleep $((try * 5))
    done
  fi
  if [ $ok = 0 ]; then
    for try in 1 2 3; do
      log "curl download $M_REPO try $try"
      local pids=()
      for f in "${FILES[@]}"; do
        mkdir -p "$(dirname "$dir/$f")"
        curl -fsSL --retry 5 --retry-delay 3 -C - -o "$dir/$f" "https://huggingface.co/$M_REPO/resolve/main/$f" >> "$LOG" 2>&1 &
        pids+=($!)
      done
      ok=1
      for p in "${pids[@]}"; do wait "$p" || ok=0; done
      [ $ok = 1 ] && break
      sleep $((try * 5))
    done
  fi
  kill "$pl" 2>/dev/null; wait "$pl" 2>/dev/null
  [ $ok = 1 ] || fail "$id" "Model download failed ($M_REPO); see server.log"
  for f in "${FILES[@]}"; do
    [ -s "$dir/$f" ] || fail "$id" "Downloaded file missing: $f"
  done
  touch "$dir/.oc_complete"
  status downloading 1 "Download of $id complete" "$id" "$M_BYTES" "$M_BYTES"
  log "download complete: $id"
}

build_args() { # <modelId> <dir> <ctx> <lean>
  local a
  ARGS=(-m "$2/${M_FILES[0]}" --host 127.0.0.1 --port 8080 --api-key "$OC_API_KEY" --alias "$1"
        -ngl 99 -c "$3" --jinja --flash-attn on)
  if [ "$4" != 1 ]; then ARGS+=(--cache-type-k q8_0 --cache-type-v q8_0); fi
  if [ -n "${M_MMPROJ:-}" ]; then ARGS+=(--mmproj "$2/$M_MMPROJ"); fi
  for a in "${M_ARGS[@]}" "${OC_EXTRA[@]}"; do ARGS+=("${a//\{modelDir\}/$2}"); done
}

wait_healthy() { # <pid>
  local t0 code
  t0=$(date +%s)
  while kill -0 "$1" 2>/dev/null; do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/health)
    [ "$code" = 200 ] && return 0
    if [ $(( $(date +%s) - t0 )) -gt $((LOAD_MAX_MIN * 60)) ]; then log "load timeout after ${LOAD_MAX_MIN} min"; return 1; fi
    sleep 3
  done
  return 1
}

serve() { # <modelId>
  local id=$1 dir crashes=0 ctx lean=0 lp rc
  oc_model "$id" || fail "$id" "Unknown model id: $id"
  echo $$ > "$OC/serve.pid"
  echo "$id" > "$OC/current_model"
  touch "$OC/busy"
  download_model "$id"
  dir=$MODELS/$id
  ctx=$M_CTX
  while :; do
    build_args "$id" "$dir" "$ctx" "$lean"
    status loading 0 "Loading $id into VRAM" "$id" "$M_BYTES" "$M_BYTES"
    log "starting: $LLAMA_BIN ${ARGS[*]//$OC_API_KEY/***}"
    "$LLAMA_BIN" "${ARGS[@]}" >> "$LOG" 2>&1 &
    lp=$!
    echo "$lp" > "$OC/llama.pid"
    if wait_healthy "$lp"; then
      status ready 1 "Serving $id" "$id" "$M_BYTES" "$M_BYTES"
      touch "$OC/was_ready" "$OC/last_inference"
      rm -f "$OC/busy"
      log "ready: $id"
      wait "$lp"; rc=$?
      [ -f "$OC/switching" ] && exit 0
      crashes=$((crashes + 1))
      log "llama-server exited (rc=$rc) while serving; crash $crashes"
      [ $crashes -gt 1 ] && fail "$id" "llama-server crashed twice (rc=$rc); see server.log"
      touch "$OC/busy"
    else
      kill "$lp" 2>/dev/null; sleep 2; kill -9 "$lp" 2>/dev/null; wait "$lp" 2>/dev/null
      [ -f "$OC/switching" ] && exit 0
      crashes=$((crashes + 1))
      log "llama-server failed to load $id (attempt $crashes)"
      [ $crashes -gt 1 ] && fail "$id" "llama-server failed to load $id; see server.log"
      # Restart once with half the context (OOM mitigation); GLM: also drop the q8_0 KV flags (MLA cache).
      ctx=$((ctx / 2))
      case "$M_FAMILY" in glm*) lean=1 ;; esac
      log "retrying with -c $ctx lean=$lean"
    fi
  done
}

do_switch() { # <modelId>
  local id=$1 sp lp i
  oc_model "$id" || { echo "unknown model: $id" >&2; exit 2; }
  touch "$OC/switching" "$OC/busy"
  status switching 0 "Switching to $id" "$id" 0 "$M_BYTES"
  log "switch to $id requested"
  sp=$(cat "$OC/serve.pid" 2>/dev/null)
  lp=$(cat "$OC/llama.pid" 2>/dev/null)
  if [ -n "$sp" ]; then kill -TERM -- "-$sp" 2>/dev/null || kill -TERM "$sp" 2>/dev/null; fi
  if [ -n "$lp" ]; then
    kill "$lp" 2>/dev/null
    for i in $(seq 1 30); do kill -0 "$lp" 2>/dev/null || break; sleep 1; done
    kill -9 "$lp" 2>/dev/null
  fi
  if [ -n "$sp" ]; then kill -KILL -- "-$sp" 2>/dev/null; fi
  rm -f "$OC/switching"
  bg bash "$OC/bootstrap.sh" serve "$id" >> "$OC/bootstrap.log" 2>&1 </dev/null &
  echo "switching to $id"
}

main() {
  local id
  log "bootstrap start (requested model ${OC_MODEL_ID:-?})"
  type oc_model >/dev/null 2>&1 || fail "${OC_MODEL_ID:-}" "config.sh missing or invalid"
  [ -n "${OC_API_KEY:-}" ] || fail "${OC_MODEL_ID:-}" "OC_API_KEY missing"
  printf '#!/bin/bash\nexec bash %s/bootstrap.sh switch "$@"\n' "$OC" > "$OC/switch.sh"
  chmod 700 "$OC/switch.sh"
  id=$(cat "$OC/current_model" 2>/dev/null)
  [ -n "$id" ] || id=${OC_MODEL_ID:-}
  serve "$id"
}

case "${1:-main}" in
  main) main ;;
  serve) serve "${2:?model id}" ;;
  switch) do_switch "${2:?model id}" ;;
  *) echo "usage: bootstrap.sh main|serve <id>|switch <id>" >&2; exit 2 ;;
esac
