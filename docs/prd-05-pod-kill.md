# PRD-05 진행 가이드: 예약 처리 중 Producer Pod 강제 종료

예약 요청을 처리하는 도중 Producer Pod를 죽여도 **반쪽 상태**(예약만 있고 outbox 이벤트가 없거나, 그 반대)가 생기지 않는지 실제 환경에서 확인한다.

- 커밋 전에 죽었으면 예약과 이벤트 둘 다 없어야 한다
- 커밋 후에 죽었으면 예약과 이벤트 둘 다 있어야 한다

## 파일

| 파일 | 역할 |
|---|---|
| `scenarios/prd-05-pod-kill.js` | k6 부하. VU마다 "예약 → 취소"를 반복한다 |
| `scripts/prd-05-kill-pods.sh` | 부하 중 Producer Pod를 정해진 간격으로 죽이고 시각과 Pod 변화를 `results/`에 남긴다 |
| `scenarios/prd-05-verify.sql` | 판정 SQL ①~⑤와 집계, Relay 미전송 확인 |

## 계획서와 달라진 점

1. **슬롯 간격은 30분이 아니라 1시간이다.** 예약 1건이 1시간(`ReservationTimePolicy.DURATION`)이라 30분 간격이면 옆 VU의 예약과 겹쳐 `409 RESERVATION_CONFLICT`가 난다. VU 30개면 `START_AT`부터 30시간을 쓴다.
2. **`kubectl exec <pod> -- kill -9 1`은 효과가 없을 가능성이 높다.** Producer 이미지는 `ENTRYPOINT ["java", "-jar", ...]`라 java가 PID 1이다. 리눅스 커널은 같은 PID 네임스페이스 안에서 PID 1에 보낸 SIGKILL을 무시한다. 계획서대로 한 번 해 보고(재시작이 없으면 스크립트가 경고를 남긴다), 실제로 프로세스를 즉시 죽일 때는 `node-kill` 방식을 쓴다. `node-kill`은 `kubectl debug node`로 노드의 PID 네임스페이스에 들어가 java 프로세스에 `kill -9`를 보낸다.
3. **생성 요청이 끊기면 같은 Idempotency-Key로 최대 3번 다시 보낸다.** 커밋 후에 죽었으면 처음 만든 예약이, 커밋 전에 죽었으면 새 예약이 돌아온다. 이것으로 ⑤(멱등성 키)도 함께 확인된다.
4. 기본 부하 시간은 2분이 아니라 **3분**이다. `node-kill`은 디버그 Pod를 띄우는 데 몇 초가 더 걸려서 두 번째 종료 뒤에도 여유를 둔다.

## 준비

### 1. 도구와 권한

- k6, kubectl, DB 접속(mysql 클라이언트 등)
- kubectl 권한: Pod 조회·삭제, `pods/exec`, `node-kill`을 쓰려면 `kubectl debug node`(노드에 hostPID Pod를 띄울 수 있어야 한다. 네임스페이스에 Pod Security `restricted`/`baseline`이 걸려 있으면 막힌다)

### 2. Producer replica 2개 이상

한 Pod가 죽는 동안 다른 Pod가 요청을 받아야 진행 중인 트랜잭션이 많이 생긴다.

Producer(`command-api`)는 Deployment가 아니라 Argo Rollouts의 `Rollout`이다.

```bash
kubectl get rollout -n dangcharge                   # command-api의 DESIRED/AVAILABLE이 2 이상인지
kubectl get rollout command-api -n dangcharge -o jsonpath='{.spec.selector.matchLabels}{"\n"}'
                                                    # Pod 라벨 (SELECTOR에 쓴다)
# 2개보다 적으면
kubectl patch rollout command-api -n dangcharge --type merge -p '{"spec":{"replicas":2}}'
```

`kill-pods.sh`는 `kubectl`이 되는 서버(control-plane 등)에서 실행한다. 파일만 복사해 가도 되고, 결과는 실행한 폴더의 `results/`에 남는다.

```bash
scp scripts/prd-05-kill-pods.sh ubuntu@<control-plane>:~/
```

### 3. `.env` 설정

```bash
cp .env.example .env   # 이미 있으면 생략
```

```dotenv
BASE_URL=https://api.dangcharge.cloud/command
STATION_ID=<충전소 ID>
CHARGER_ID=<충전기 ID>        # 없으면 충전소의 고장 아닌 첫 충전기
VEHICLE_MODEL=TESLA           # 충전소가 지원하는 차종. 없으면 지원 차종 중 첫 번째
START_AT=2026-10-21T00:00:00+09:00   # 없으면 내일 00:00 KST
USERS=30
DURATION=3m
```

- `START_AT`은 정각 또는 30분이어야 하고, `START_AT + USERS시간`이 7일 안이어야 한다
- 취소는 시작 10분 전까지만 되므로 `START_AT`은 지금보다 충분히 뒤(내일 이후)로 둔다
- setup이 `START_AT`부터 `USERS`개 슬롯이 그 충전기에서 모두 비어 있는지 확인한다. 하나라도 차 있으면 바로 실패하니 `START_AT`이나 `CHARGER_ID`를 바꾼다

### 4. 사전 점검 (Pod를 죽이지 않고 짧게)

```bash
USERS=2 DURATION=10s ./run.sh scenarios/prd-05-pod-kill.js
```

`reservation_created`와 `reservation_canceled`가 늘고 `unexpected`, `reservation_conflict`가 0이면 된다. 이때는 Pod를 죽이지 않았으니 `failed: count>0` threshold만 실패하는 게 정상이다.

## 본 실행

종료 방식 3가지(`delete`, `exec-kill`, `node-kill`)를 **각각 한 번씩** 실행한다. 매 실행마다 k6를 새로 돌린다(사용자를 새로 만들고, 끝날 때 남은 예약을 정리한다).

### 터미널 A: 부하

```bash
mkdir -p results
./run.sh scenarios/prd-05-pod-kill.js 2>&1 | tee results/prd-05-k6-delete.log
```

setup이 끝나면 아래 줄이 찍힌다. 여기서 `테스트 시작(UTC)` 값을 기록해 둔다.

```
PRD-05 run=... charger=... slots=... 테스트 시작(UTC)=2026-10-19 02:00:00.000
PRD-05 부하 시작. 지금 다른 터미널에서 scripts/prd-05-kill-pods.sh를 실행하세요
```

### 터미널 B: Pod 종료 (위 줄이 찍히자마자)

```bash
SELECTOR=app=<producer 라벨> NAMESPACE=<ns> ./scripts/prd-05-kill-pods.sh delete
```

기본값은 30초 뒤 첫 종료, 60초 뒤 다른 Pod로 두 번째 종료다. 바꾸려면 `<방식> <첫 종료까지 초> <간격 초> <횟수>` 순서로 넘긴다. 예: `... node-kill 30 50 2`

스크립트가 `results/prd-05-<시각>-<방식>/`에 남기는 것:

- `kill.log`: 종료한 Pod와 시각(UTC, KST), kubectl 출력, `exec-kill` 재시작 여부 경고, `node-kill`이 죽인 PID
- `pods-watch.log`: 시각이 붙은 `kubectl get pods -w` 출력 (Pod 종료와 재시작 확인)
- `pods-before.txt`, `pods-after.txt`: 시작 전과 끝난 뒤 Pod 목록(RESTARTS 포함)

`delete`는 Pod 이름이 새로 바뀌고, `exec-kill`/`node-kill`은 같은 Pod의 RESTARTS가 1 늘어난다.

### 나머지 두 방식

```bash
# A
./run.sh scenarios/prd-05-pod-kill.js 2>&1 | tee results/prd-05-k6-exec-kill.log
# B
SELECTOR=... NAMESPACE=... ./scripts/prd-05-kill-pods.sh exec-kill

# A
./run.sh scenarios/prd-05-pod-kill.js 2>&1 | tee results/prd-05-k6-node-kill.log
# B
SELECTOR=... NAMESPACE=... ./scripts/prd-05-kill-pods.sh node-kill
```

`exec-kill`에서 "재시작 없음" 경고가 나오면 그 자체가 증적이다(PID 1이라 SIGKILL이 무시됨). 이 경우 그 회차는 Pod가 죽지 않았으니 `failed`도 0일 수 있다.

## 결과 읽기

### k6

| 지표 | 의미 | 기대 |
|---|---|---|
| `failed` | Pod 종료로 끊긴 요청(status 0 또는 5xx). `op` 태그로 create/cancel/me 구분 | **0보다 커야 한다.** 0이면 요청 도중에 끊긴 적이 없어 테스트가 성립하지 않는다 |
| `reservation_created` / `reservation_canceled` | 정상 생성·취소 수 | 계속 늘어야 한다 |
| `create_retry_ok` | 끊긴 생성을 같은 Idempotency-Key로 다시 보내 성공한 수 | 참고 |
| `leftover_canceled` | 취소가 끊겨 남은 예약을 다음 반복에서 찾아 취소한 수 | 참고 |
| `reservation_conflict` | 슬롯 겹침 | 0 |
| `unexpected` | 그 밖의 응답(4xx 등) | 0 |
| `checks{phase:verify}` | 끝난 뒤 진행 중 예약이 남지 않았는지 | 100% |

`failed`, `reservation_conflict`, `unexpected`, `checks{phase:verify}`는 threshold로 걸려 있어 어긋나면 k6가 실패로 끝난다(exit code 99).

### 판정 SQL

k6가 끝나면 teardown이 다음 줄을 출력한다.

```
SET @t0 = '2026-10-19 02:00:00.000';
```

DB에 접속해 이 줄을 먼저 실행하고 `scenarios/prd-05-verify.sql`을 실행한다.

```bash
mysql -h <host> -u <user> -p <db> -t \
  -e "SET @t0 = '2026-10-19 02:00:00.000'; source scenarios/prd-05-verify.sql;" \
  | tee results/prd-05-sql-delete.txt
```

- ①~⑤ 결과가 모두 0건, "한 번에 보기"의 다섯 값이 모두 0이면 **합격**
- "참고" 집계에서 `reservations`, `created_events`가 0보다 커야 부하가 실제로 DB까지 간 것이다
- 마지막 `unsent`가 몇 초 뒤 0이면 Relay가 Kafka로 전부 보낸 것이다(선택)
- `@t0`는 setup 시작보다 1분 앞당긴 UTC 값이라 PC와 DB 시각이 조금 달라도 데이터가 빠지지 않는다. 그 사이에 다른 트래픽이 있어도 같은 규칙을 지켜야 하므로 판정에는 문제가 없다

### 원자성 단위 테스트 (같이 첨부)

죽는 순간이 커밋 직전·직후 몇 ms 사이에 걸린다는 보장은 없다. 트랜잭션 중간 실패 시 예약과 이벤트가 둘 다 롤백된다는 것은 Producer의 `ReservationOutboxAtomicityTest`가 확정적으로 검증한다.

```bash
cd ../dangcharge_Producer
./gradlew test --tests '*ReservationOutboxAtomicityTest'
```

## 증적 체크리스트

방식(`delete`, `exec-kill`, `node-kill`)마다:

- [ ] 종료 방식 이름
- [ ] k6 결과 요약 (`results/prd-05-k6-<방식>.log`의 끝부분). `failed` > 0
- [ ] `kill.log`: 종료 시각과 대상 Pod
- [ ] `pods-watch.log`: Pod 종료와 재시작
- [ ] 판정 SQL 결과 (`results/prd-05-sql-<방식>.txt`). ①~⑤ 모두 0건
- [ ] (선택) Relay `unsent` = 0

공통:

- [ ] `ReservationOutboxAtomicityTest` 통과 결과
- [ ] 한계: 종료 시점이 커밋 직전·직후 사이에 정확히 걸린다는 보장은 없다. 여러 번 죽여도 반쪽 상태가 생기지 않는다는 증거이고, 확정적 검증은 위 단위 테스트가 맡는다

## 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| setup에서 "비어 있지 않은 슬롯이 있습니다" | 그 충전기의 해당 시간에 다른 예약이 있다. `START_AT`을 다른 날로 바꾸거나 `CHARGER_ID`를 바꾼다 |
| `reservation_conflict` > 0 | 테스트 도중 다른 사람이 같은 슬롯을 예약했다. 다른 충전기로 다시 한다 |
| `unexpected`에 `RESERVATION_NOT_CANCELABLE` | `START_AT`이 너무 가깝다. 내일 이후로 둔다 |
| `unexpected`에 401 | 토큰 만료. `DURATION`을 줄이거나 다시 실행한다 |
| `failed`가 0 | Pod가 실제로 죽지 않았거나(`exec-kill`), graceful shutdown으로 요청을 다 처리하고 내려갔다(`delete`). `node-kill`로 다시 한다 |
| `node-kill`에서 "디버그 Pod를 만들지 못했습니다" | `kubectl debug node` 권한이 없거나 Pod Security가 막는다. `DEBUG_PROFILE=legacy`로 바꿔 보거나, 노드에 직접 접속해 `kill -9 <java PID>`로 대신한다 |
| `node-kill` 출력에 `kill -9 pid=...`가 없음 | Pod UID로 프로세스를 못 찾았다. 디버그 Pod에서 `ps`로 java 프로세스를 직접 찾아 죽인다 |
| 디버그 Pod(`node-debugger-...`)가 남음 | 스크립트가 지우지만, 중간에 멈췄다면 `kubectl get pods -n <ns> \| grep node-debugger`로 찾아 지운다 |
