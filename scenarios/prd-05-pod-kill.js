/**
 * PRD-05 예약 처리 중 Producer Pod 강제 종료 시 반쪽 상태 없음
 *
 * VU마다 "예약 → 취소"를 반복해 쓰기 트랜잭션이 계속 진행되게 하고, 그동안 다른 터미널에서
 * scripts/prd-05-kill-pods.sh로 Producer Pod를 죽인다. 끝난 뒤 scenarios/prd-05-verify.sql로
 * 예약과 outbox 이벤트 중 한쪽만 남은 행이 없는지 확인한다. 진행 방법은 docs/prd-05-pod-kill.md
 *
 * - 1인 1예약 규칙(RESERVATION_ALREADY_ACTIVE) 때문에 사용자는 VU마다 따로 만든다
 * - 예약 1건이 1시간이라 VU마다 1시간씩 떨어진 슬롯을 쓴다 (30분 간격이면 옆 VU와 겹쳐 409가 난다)
 * - Pod가 죽어 생긴 실패(연결 끊김, 5xx)는 failed에 센다. failed가 0이면 요청 도중에 끊긴 적이 없어 테스트가 성립하지 않는다
 * - 생성이 실패하면 같은 Idempotency-Key로 다시 보낸다. 커밋 뒤에 죽었으면 처음 만든 예약이, 커밋 전에 죽었으면 새 예약이 돌아온다
 * - 취소가 실패해 예약이 남으면 다음 반복에서 RESERVATION_ALREADY_ACTIVE를 받고, 내 예약을 찾아 취소한다
 *
 * 실행
 *   ./run.sh scenarios/prd-05-pod-kill.js   (.env를 읽어 k6에 넘긴다)
 *
 * 환경 변수 (.env 또는 -e로 지정)
 *   BASE_URL       서버 주소 (필수)
 *   STATION_ID     예약할 충전소 ID (필수)
 *   CHARGER_ID     예약할 충전기 ID (없으면 충전소에서 고장이 아닌 첫 충전기)
 *   VEHICLE_MODEL  가입시킬 차종 (없으면 충전소가 지원하는 첫 차종)
 *   START_AT       첫 VU의 예약 시작 시각, 예: 2026-10-21T00:00:00+09:00 (없으면 내일 00:00 KST)
 *   USERS          VU 수 = 사용자 수 (기본 30). VU i는 START_AT + i시간 슬롯을 쓴다
 *   DURATION       부하 시간 (기본 3m)
 */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) {
  throw new Error('BASE_URL 환경 변수가 필요합니다. .env를 만들고 ./run.sh로 실행하세요');
}
const STATION_ID = __ENV.STATION_ID;
const USERS = parseInt(__ENV.USERS || '30', 10);
const DURATION = __ENV.DURATION || '3m';
const PASSWORD = 'k6Password123';
const HOUR_MS = 60 * 60 * 1000;
// 죽은 Pod로 간 요청이 오래 매달리지 않게 기본(60s)보다 짧게 둔다
const REQUEST_TIMEOUT = '10s';
// 생성 실패 시 같은 Idempotency-Key로 다시 보내는 횟수
const CREATE_RETRIES = 3;

const created = new Counter('reservation_created');
const canceled = new Counter('reservation_canceled');
const failed = new Counter('failed');
const retryOk = new Counter('create_retry_ok');
const leftoverCanceled = new Counter('leftover_canceled');
const conflict = new Counter('reservation_conflict');
const unexpected = new Counter('unexpected');

export const options = {
  setupTimeout: '180s',
  teardownTimeout: '180s',
  scenarios: {
    reserve_and_cancel: {
      executor: 'constant-vus',
      vus: USERS,
      duration: DURATION,
    },
  },
  thresholds: {
    // Pod 종료로 끊긴 요청이 있어야 테스트가 성립한다
    failed: ['count>0'],
    // 슬롯이 다른 예약과 겹치면 그 VU는 아무것도 쓰지 못한다
    reservation_conflict: ['count==0'],
    unexpected: ['count==0'],
    'checks{phase:verify}': ['rate==1'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function authHeaders(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

function dataOf(res, label) {
  if (res.status < 200 || res.status >= 300) {
    fail(`${label} 실패: ${res.status} ${res.body}`);
  }
  return res.json('data');
}

/** Pod가 죽어서 생긴 실패: 연결 끊김·타임아웃(status 0)이나 게이트웨이·서버 오류 */
function isPodFailure(res) {
  return res.status === 0 || res.status >= 500;
}

function errorCode(res) {
  try {
    return res.json('error.code');
  } catch (e) {
    return null;
  }
}

function kstDate(time) {
  return new Date(time + 9 * HOUR_MS).toISOString().slice(0, 10);
}

/** DB 비교용 UTC 문자열. 예: 2026-10-19 01:23:45.678 */
function utcSql(time) {
  return new Date(time).toISOString().replace('T', ' ').replace('Z', '');
}

function pickTarget() {
  if (!STATION_ID) {
    fail('STATION_ID 환경 변수가 필요합니다');
  }
  const station = dataOf(http.get(`${BASE_URL}/api/v1/stations/${STATION_ID}`), '충전소 조회');

  const vehicleModel = __ENV.VEHICLE_MODEL || station.supportedModels[0];
  if (!vehicleModel || !station.supportedModels.includes(vehicleModel)) {
    fail(`충전소 ${STATION_ID}가 지원하는 차종이 아닙니다: ${vehicleModel} (지원: ${station.supportedModels})`);
  }

  const charger = __ENV.CHARGER_ID
    ? station.chargers.find((c) => String(c.chargerId) === String(__ENV.CHARGER_ID))
    : station.chargers.find((c) => c.status !== 'OUT_OF_SERVICE');
  if (!charger || charger.status === 'OUT_OF_SERVICE') {
    fail(`충전소 ${STATION_ID}에 예약할 수 있는 충전기가 없습니다`);
  }
  return { vehicleModel, chargerId: charger.chargerId };
}

function signUpAndLogin(runId, vehicleModel) {
  const loginIds = Array.from({ length: USERS }, (_, i) => `prd05-${runId}-${i}`);

  const signups = http.batch(loginIds.map((loginId) => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/auth/signup`,
    body: JSON.stringify({ loginId, username: loginId, password: PASSWORD, vehicleModel }),
    params: { headers: JSON_HEADERS },
  })));
  signups.forEach((res, i) => dataOf(res, `회원가입(${loginIds[i]})`));

  const logins = http.batch(loginIds.map((loginId) => ({
    method: 'POST',
    url: `${BASE_URL}/api/v1/auth/login`,
    body: JSON.stringify({ loginId, password: PASSWORD }),
    params: { headers: JSON_HEADERS },
  })));
  return logins.map((res, i) => dataOf(res, `로그인(${loginIds[i]})`).accessToken);
}

/** VU마다 1시간씩 떨어진 슬롯을 만들고, 모두 비어 있는지 예약 가능 시간 조회로 확인한다 */
function pickSlots(token, chargerId) {
  const base = Date.parse(__ENV.START_AT || `${kstDate(Date.now() + 24 * HOUR_MS)}T00:00:00+09:00`);
  if (Number.isNaN(base) || base % (30 * 60 * 1000) !== 0) {
    fail(`START_AT은 정각 또는 30분이어야 합니다: ${__ENV.START_AT}`);
  }
  const slots = Array.from({ length: USERS }, (_, i) => base + i * HOUR_MS);

  const statusByStart = {};
  [...new Set(slots.map(kstDate))].forEach((date) => {
    const daySlots = dataOf(http.get(`${BASE_URL}/api/v1/stations/${STATION_ID}/availability?date=${date}`,
      { headers: authHeaders(token) }), `예약 가능 시간 조회(${date})`);
    daySlots
      .filter((s) => s.chargerId === chargerId)
      .forEach((s) => { statusByStart[Date.parse(s.startAt)] = s.status; });
  });

  const busy = slots.filter((t) => statusByStart[t] !== 'enable');
  if (busy.length > 0) {
    fail(`충전기 ${chargerId}에 비어 있지 않은 슬롯이 있습니다: `
      + `${busy.map((t) => `${new Date(t).toISOString()}(${statusByStart[t] || '없음'})`).join(', ')}. `
      + 'START_AT이나 CHARGER_ID를 바꾸세요');
  }
  return slots.map((t) => new Date(t).toISOString());
}

export function setup() {
  // DB 시각과 이 PC 시각이 조금 달라도 테스트 데이터가 빠지지 않게 1분 앞당겨 둔다
  const startedAt = Date.now() - 60 * 1000;
  const { vehicleModel, chargerId } = pickTarget();
  const runId = Date.now().toString(36);
  const tokens = signUpAndLogin(runId, vehicleModel);
  const slots = pickSlots(tokens[0], chargerId);

  // 값이 0이어도 지표가 생겨 thresholds가 판정된다
  [created, canceled, failed, retryOk, leftoverCanceled, conflict, unexpected].forEach((c) => c.add(0));

  console.log(`PRD-05 run=${runId} station=${STATION_ID} charger=${chargerId} vehicle=${vehicleModel} `
    + `users=${USERS} duration=${DURATION} slots=${slots[0]} ~ ${slots[slots.length - 1]} `
    + `테스트 시작(UTC)=${utcSql(startedAt)}`);
  console.log('PRD-05 부하 시작. 지금 다른 터미널에서 scripts/prd-05-kill-pods.sh를 실행하세요');
  return { runId, tokens, chargerId, slots, startedAt };
}

function cancel(token, reservationId) {
  const res = http.del(`${BASE_URL}/api/v1/reservations/${reservationId}`, null, {
    headers: authHeaders(token),
    timeout: REQUEST_TIMEOUT,
    tags: { name: 'DELETE /api/v1/reservations/{id}' },
  });
  if (res.status === 200) {
    return true;
  }
  if (isPodFailure(res)) {
    // 예약이 남았으면 다음 반복에서 RESERVATION_ALREADY_ACTIVE로 찾아 취소한다
    failed.add(1, { op: 'cancel' });
  } else {
    unexpected.add(1, { op: 'cancel' });
    console.error(`취소 응답 이상 VU=${__VU} id=${reservationId}: ${res.status} ${res.body}`);
  }
  return false;
}

/** 이전 반복에서 취소가 끊겨 남은 내 예약을 찾아 취소한다 */
function cancelLeftover(token) {
  const res = http.get(`${BASE_URL}/api/v1/reservations/me`, {
    headers: authHeaders(token),
    timeout: REQUEST_TIMEOUT,
    tags: { name: 'GET /api/v1/reservations/me' },
  });
  if (isPodFailure(res)) {
    failed.add(1, { op: 'me' });
    return;
  }
  const reservationId = res.json('data.reservation.reservationId');
  if (reservationId && cancel(token, reservationId)) {
    leftoverCanceled.add(1);
  }
}

export default function (data) {
  const token = data.tokens[__VU - 1];
  const startAt = data.slots[__VU - 1];
  const params = {
    headers: { ...authHeaders(token), 'Idempotency-Key': `prd05-${data.runId}-${__VU}-${__ITER}` },
    timeout: REQUEST_TIMEOUT,
    responseCallback: http.expectedStatuses(201, 409),
    tags: { name: 'POST /api/v1/reservations' },
  };
  const body = JSON.stringify({ chargerId: data.chargerId, startAt });

  let res = http.post(`${BASE_URL}/api/v1/reservations`, body, params);
  for (let retry = 1; retry <= CREATE_RETRIES && isPodFailure(res); retry++) {
    failed.add(1, { op: 'create' });
    sleep(1);
    res = http.post(`${BASE_URL}/api/v1/reservations`, body, params);
    if (res.status === 201) {
      retryOk.add(1);
    }
  }

  const code = res.status === 201 ? null : errorCode(res);
  if (res.status === 201) {
    created.add(1);
    if (cancel(token, res.json('data.reservationId'))) {
      canceled.add(1);
    }
  } else if (res.status === 409 && code === 'RESERVATION_ALREADY_ACTIVE') {
    cancelLeftover(token);
  } else if (res.status === 409 && code === 'RESERVATION_CONFLICT') {
    conflict.add(1);
    console.error(`슬롯 겹침 VU=${__VU} startAt=${startAt}: 다른 예약이 이 슬롯을 쓰고 있습니다`);
    sleep(1);
  } else if (isPodFailure(res)) {
    failed.add(1, { op: 'create' });
  } else {
    unexpected.add(1, { op: 'create' });
    console.error(`생성 응답 이상 VU=${__VU}: ${res.status} ${res.body}`);
  }
}

export function teardown(data) {
  const tags = { phase: 'verify' };
  const meOf = () => http.batch(data.tokens.map((token) => ({
    method: 'GET',
    url: `${BASE_URL}/api/v1/reservations/me`,
    params: { headers: authHeaders(token) },
  })));

  // 테스트가 끝날 때 남은 예약을 정리한다. 다음 실행에서 같은 슬롯을 쓸 수 있게 한다
  meOf().forEach((res, i) => {
    const reservationId = res.status === 200 ? res.json('data.reservation.reservationId') : null;
    if (reservationId) {
      http.del(`${BASE_URL}/api/v1/reservations/${reservationId}`, null,
        { headers: authHeaders(data.tokens[i]) });
    }
  });
  const left = meOf().filter((res) => res.status !== 200 || res.json('data.state') !== 'NONE').length;
  check(left, { '정리 후 진행 중 예약을 가진 사용자 없음': (n) => n === 0 }, tags);

  console.log(`PRD-05 끝 run=${data.runId}. 판정 SQL은 아래 SET 한 줄을 먼저 실행한 뒤 scenarios/prd-05-verify.sql을 실행하세요\n`
    + `SET @t0 = '${utcSql(data.startedAt)}';`);
}
