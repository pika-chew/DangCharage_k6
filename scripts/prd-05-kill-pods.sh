#!/usr/bin/env bash
# PRD-05 부하 중 Producer Pod를 정해진 간격으로 죽이고, 종료 시각과 Pod 상태 변화를 results/에 남긴다
#
# 사용: SELECTOR=app=<producer 라벨> [NAMESPACE=ns] ./scripts/prd-05-kill-pods.sh <방식> [첫 종료까지 초=30] [간격 초=60] [횟수=2]
#
# 방식
#   delete     kubectl delete pod --grace-period=0 --force. API에서 Pod 객체만 바로 지운다.
#              컨테이너는 노드에서 SIGTERM을 받고 잠깐 더 살 수 있어(graceful shutdown) 요청이 덜 끊긴다
#   exec-kill  kubectl exec <pod> -- kill -9 1. 이미지가 java를 PID 1로 띄우면 커널이 무시한다
#              (같은 PID 네임스페이스 안에서 PID 1에 보낸 SIGKILL은 전달되지 않는다). 재시작이 없으면 경고를 남긴다
#   node-kill  kubectl debug node로 노드의 PID 네임스페이스에 들어가 java 프로세스에 kill -9를 보낸다.
#              프로세스가 즉시 죽어 진행 중인 요청이 확실히 끊긴다
#
# 환경 변수
#   SELECTOR       Producer Pod 라벨 셀렉터 (필수). 예: app=dangcharge-producer
#   NAMESPACE      네임스페이스 (없으면 현재 컨텍스트의 네임스페이스)
#   CONTAINER      Pod에 컨테이너가 여럿이면 대상 컨테이너 이름 (exec-kill)
#   DEBUG_IMAGE    node-kill 디버그 Pod 이미지 (기본 busybox:1.36)
#   DEBUG_PROFILE  node-kill 디버그 프로파일 (기본 sysadmin)
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=${1:-}
FIRST_DELAY=${2:-30}
INTERVAL=${3:-60}
COUNT=${4:-2}

case "$MODE" in
  delete | exec-kill | node-kill) ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 1
    ;;
esac
: "${SELECTOR:?SELECTOR가 필요합니다. 예: SELECTOR=app=dangcharge-producer}"
NAMESPACE=${NAMESPACE:-$(kubectl config view --minify -o jsonpath='{..namespace}')}
NAMESPACE=${NAMESPACE:-default}
DEBUG_IMAGE=${DEBUG_IMAGE:-busybox:1.36}
DEBUG_PROFILE=${DEBUG_PROFILE:-sysadmin}

OUT="results/prd-05-$(date +%Y%m%d-%H%M%S)-$MODE"
mkdir -p "$OUT"
LOG="$OUT/kill.log"

k() { kubectl -n "$NAMESPACE" "$@"; }
stamp() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) (KST $(TZ=Asia/Seoul date +%H:%M:%S))"; }
log() { echo "[$(stamp)] $*" | tee -a "$LOG"; }

restarts() {
  k get pod "$1" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo '?'
}

# 지워지는 중이 아니고 Ready인 Pod 이름
ready_pods() {
  k get pods -l "$SELECTOR" -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.deletionTimestamp}{" "}{.status.containerStatuses[0].ready}{"\n"}{end}' \
    | awk 'NF == 2 && $2 == "true" { print $1 }'
}

# 아직 죽이지 않은 Pod를 고른다. 모두 한 번씩 죽였으면 첫 Pod를 고른다
KILLED=" "
pick_pod() {
  for p in $1; do
    case "$KILLED" in *" $p "*) ;; *) echo "$p"; return ;; esac
  done
  echo "$1" | head -1
}

kill_delete() {
  k delete pod "$1" --grace-period=0 --force 2>&1 | tee -a "$LOG" || true
}

kill_exec() {
  local before
  before=$(restarts "$1")
  local exec_args=()
  if [ -n "${CONTAINER:-}" ]; then exec_args=(-c "$CONTAINER"); fi
  k exec "$1" ${exec_args[@]+"${exec_args[@]}"} -- kill -9 1 2>&1 | tee -a "$LOG" || true
  sleep 5
  if [ "$(restarts "$1")" = "$before" ]; then
    log "경고: $1 재시작 없음(restartCount=$before). PID 1이 같은 네임스페이스에서 보낸 SIGKILL을 무시했다. node-kill을 쓰세요"
  fi
}

kill_node() {
  local pod=$1 node uid uid_us dbg
  node=$(k get pod "$pod" -o jsonpath='{.spec.nodeName}')
  uid=$(k get pod "$pod" -o jsonpath='{.metadata.uid}')
  # cgroup 경로에 Pod UID가 그대로(cgroupfs) 또는 '-'가 '_'로 바뀌어(systemd) 들어간다
  uid_us=$(echo "$uid" | tr '-' '_')

  dbg=$(k debug "node/$node" --image="$DEBUG_IMAGE" --profile="$DEBUG_PROFILE" -- sleep 600 2>&1 \
    | sed -n 's/^Creating debugging pod \([^ ]*\) .*/\1/p')
  if [ -z "$dbg" ]; then
    log "디버그 Pod를 만들지 못했습니다(node=$node). kubectl debug node 권한과 Pod Security 설정을 확인하세요"
    return
  fi
  k wait --for=condition=Ready "pod/$dbg" --timeout=90s >/dev/null

  # 디버그 Pod 준비에 시간이 걸려 실제 kill 시각을 다시 남긴다
  log "node-kill 실행: $pod (node=$node, debug=$dbg)"
  k exec "$dbg" -- sh -c "
    for f in \$(grep -l -e '$uid' -e '$uid_us' /proc/[0-9]*/cgroup 2>/dev/null); do
      pid=\$(echo \"\$f\" | cut -d/ -f3)
      if tr '\\0' ' ' < /proc/\$pid/cmdline 2>/dev/null | grep -q 'app.jar'; then
        kill -9 \$pid && echo \"kill -9 pid=\$pid \$(date -u +%H:%M:%SZ)\"
      fi
    done" 2>&1 | tee -a "$LOG" || true
  k delete pod "$dbg" --wait=false >/dev/null 2>&1 || true
}

# Pod 상태 변화를 시각과 함께 기록한다
k get pods -l "$SELECTOR" -o wide -w \
  > >(while IFS= read -r line; do echo "$(date -u +%H:%M:%SZ) $line"; done > "$OUT/pods-watch.log") 2>&1 &
WATCH_PID=$!
trap 'kill "$WATCH_PID" 2>/dev/null || true' EXIT

log "PRD-05 Pod 종료 시작 mode=$MODE namespace=$NAMESPACE selector=$SELECTOR first=${FIRST_DELAY}s interval=${INTERVAL}s count=$COUNT"
k get pods -l "$SELECTOR" -o wide | tee "$OUT/pods-before.txt"
sleep "$FIRST_DELAY"

for i in $(seq 1 "$COUNT"); do
  ready=$(ready_pods)
  ready_count=$(echo "$ready" | grep -c . || true)
  pod=$(pick_pod "$ready")
  if [ -z "$pod" ]; then
    log "Ready인 Producer Pod가 없습니다. SELECTOR를 확인하세요"
    exit 1
  fi
  if [ "$ready_count" -lt 2 ]; then
    log "경고: Ready Pod가 ${ready_count}개입니다. replica 2개 이상이어야 남은 Pod가 요청을 받습니다"
  fi
  log "[$i/$COUNT] $MODE: $pod (restartCount=$(restarts "$pod"))"
  case "$MODE" in
    delete) kill_delete "$pod" ;;
    exec-kill) kill_exec "$pod" ;;
    node-kill) kill_node "$pod" ;;
  esac
  KILLED="$KILLED$pod "
  if [ "$i" -lt "$COUNT" ]; then sleep "$INTERVAL"; fi
done

log "종료 끝. 복구를 60초 기다립니다"
sleep 60
k get pods -l "$SELECTOR" -o wide | tee "$OUT/pods-after.txt"
log "결과: $OUT (kill.log, pods-watch.log, pods-before.txt, pods-after.txt)"
