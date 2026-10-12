#!/bin/bash
# Obsidian Code onstart stub (Vast "onstart"; must stay < 4000 chars after comment stripping).
# 1) arm the self-destroy watchdog FIRST, 2) unpack + start bootstrap.sh.
# Test hooks (unset in production): OC_ROOT (default /root), OC_API_BASE, OC_WD_TICK (s), OC_WD_MIN (s per "minute").
R=${OC_ROOT:-/root}; O=$R/oc
mkdir -p $O && cd $O || exit 0
touch $R/.no_auto_tmux
umask 077
pe() { tr '\0' '\n' </proc/1/environ 2>/dev/null | sed -n "s/^$1=//p" | head -n1; }
V="CONTAINER_ID CONTAINER_API_KEY OC_API_KEY OC_MODEL_ID OC_IDLE_MIN OC_HEARTBEAT_MIN OC_MAX_HOURS OC_BOOT_MAX_MIN OC_API_BASE OC_WD_TICK OC_WD_MIN"
for v in VAST_CONTAINERLABEL OC_BOOTSTRAP_GZB64 OC_CONFIG_GZB64 $V; do eval "[ -n \"\${$v:-}\" ]" || eval "$v=\$(pe $v)"; done
[ -n "$CONTAINER_ID" ] || CONTAINER_ID=${VAST_CONTAINERLABEL#C.}
[ -n "$CONTAINER_API_KEY" ] || CONTAINER_API_KEY=$(cat $R/.vast_api_key 2>/dev/null)
for v in $V; do eval "printf \"export %s='%s'\n\" $v \"\${$v:-}\""; done > env
rm -f was_ready busy last_inference switching
date +%s > boot_time
touch heartbeat
printf '{"phase":"starting","progress":0,"message":"Instance booted","modelId":"","bytesDone":0,"bytesTotal":0}\n' > status.json
cat > watchdog.sh <<'WD'
#!/bin/bash
cd "${0%/*}"; . ./env; echo $$ > watchdog.pid
L=watchdog.log; M=${OC_WD_MIN:-60}; T=${OC_WD_TICK:-30}
HB=${OC_HEARTBEAT_MIN:-10}; IDLE=${OC_IDLE_MIN:-20}; MAXH=${OC_MAX_HOURS:-6}; BOOT=${OC_BOOT_MAX_MIN:-60}
START=$(cat boot_time 2>/dev/null || date +%s)
log() { echo "$(date -u +%FT%TZ) $*" >> $L; }
age() { local m; m=$(stat -c %Y "$1" 2>/dev/null) || m=$START; echo $(( $(date +%s) - m )); }
api() { curl -s -m 30 -o /dev/null -w '%{http_code}' -X "$1" -H "Authorization: Bearer $CONTAINER_API_KEY" -H 'Content-Type: application/json' -d "$2" "${OC_API_BASE:-https://console.vast.ai}/api/v0/instances/$CONTAINER_ID/"; }
stopsrv() { local f p; for f in serve llama; do p=$(cat $f.pid 2>/dev/null) && kill -9 -- -$p $p 2>/dev/null; done; }
destroy() {
  log "self-destroy: $1"; stopsrv
  printf '{"phase":"error","progress":0,"message":"Watchdog: %s - destroying instance","modelId":"","bytesDone":0,"bytesTotal":0}\n' "$1" > status.json
  for i in 1 2 3 4 5 6; do
    c=$(api DELETE '{}'); log "DELETE $i -> $c"
    case $c in 200|404) sleep $((4*T));; *) sleep $((i*T/6+1));; esac
  done
  log "destroy not effective; stopping instance"; api PUT '{"state":"stopped"}' >> $L
}
log "armed id=$CONTAINER_ID key=${CONTAINER_API_KEY:+set} hb=$HB idle=$IDLE max=${MAXH}h boot=$BOOT"
SIG=
while sleep $T; do
  n=$(date +%s)
  if [ "$(age heartbeat)" -gt $((HB*M)) ]; then destroy "no app heartbeat for $HB min"; continue; fi
  if [ $((n-START)) -gt $((MAXH*60*M)) ]; then destroy "session longer than $MAXH h"; continue; fi
  if [ -f was_ready ]; then
    if [ -f busy ]; then touch last_inference; continue; fi
    S=$(curl -s -m 10 -H "Authorization: Bearer $OC_API_KEY" http://127.0.0.1:8080/slots | tr -d ' \n' | grep -o '"id_task":-\?[0-9]*\|"is_processing":true\|"n_decoded":[0-9]*' | tr '\n' ,)
    case "$S" in *is_processing*) touch last_inference;; esac
    if [ -n "$S" ] && [ "$S" != "$SIG" ]; then [ -n "$SIG" ] && touch last_inference; SIG=$S; fi
    if [ "$(age last_inference)" -gt $((IDLE*M)) ]; then destroy "no inference for $IDLE min"; fi
  elif [ $((n-START)) -gt $((BOOT*M)) ]; then destroy "server not ready after $BOOT min"
  fi
done
WD
bg() { if command -v setsid >/dev/null; then setsid nohup "$@"; else nohup "$@"; fi; }
bg bash $O/watchdog.sh >/dev/null 2>&1 </dev/null &
for f in BOOTSTRAP:bootstrap.sh CONFIG:config.sh; do
  eval "b=\${OC_${f%%:*}_GZB64:-}"
  [ -n "$b" ] && echo "$b" | base64 -d 2>/dev/null | gunzip > "${f#*:}.tmp" 2>/dev/null && [ -s "${f#*:}.tmp" ] && mv -f "${f#*:}.tmp" "${f#*:}"
done
if [ -s bootstrap.sh ]; then
  bg bash $O/bootstrap.sh main >> $O/bootstrap.log 2>&1 </dev/null &
else
  echo "$(date -u +%FT%TZ) bootstrap.sh missing; waiting for upload over SSH" >> bootstrap.log
fi
