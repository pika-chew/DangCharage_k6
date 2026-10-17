/**
 * PRD-04 동일 충전기·시간대 동시 예약 요청
 *
 * 사용자 50명이 같은 충전기의 같은 시간대(슬롯)에 동시에 예약을 요청한다.
 * 1인 1예약 규칙(RESERVATION_ALREADY_ACTIVE) 때문에 요청마다 사용자가 달라야 한다.
 *
 * 기대 결과
 *   - 201 성공 1건
 *   - 나머지 49건은 409 RESERVATION_CONFLICT (시간 겹침)
 *   - 50명 중 진행 중 예약(RESERVED)을 가진 사용자는 1명
 *   - outbox_events에 ReservationCreated 1건 (MSQ-04와 짝, 아래 SQL로 확인)
 *
 * 실행
 *   ./run.sh scenarios/prd-04-concurrent-reservation.js   (.env를 읽어 k6에 넘긴다)
 *
 * 환경 변수 (.env 또는 -e로 지정)
 *   BASE_URL       서버 주소 (필수)
 *   STATION_ID     예약할 충전소 ID (필수)
 *   CHARGER_ID     예약할 충전기 ID (없으면 충전소에서 고장이 아닌 첫 충전기)
 *   VEHICLE_MODEL  가입시킬 차종 (없으면 충전소가 지원하는 첫 차종)
 *   START_AT       예약 시작 시각, 예: 2026-10-18T10:00:00+09:00 (없으면 내일 비어 있는 첫 슬롯)
 *   USERS          동시 요청 수 = 사용자 수 (기본 50)
 *
 * outbox 확인 (테스트 끝에 chargerId/startAt이 채워진 SQL을 출력한다)
 *   SELECT COUNT(*) FROM outbox_events o
 *     JOIN reservations r ON o.aggregate_type = 'reservation' AND o.aggregate_id = r.id
 *    WHERE o.event_type = 'ReservationCreated' AND r.charger_id = ? AND r.starts_at = ?;  -- 기대값 1
 */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) {
  throw new Error('BASE_URL 환경 변수가 필요합니다. .env를 만들고 ./run.sh로 실행하세요');
}
const STATION_ID = __ENV.STATION_ID;
const USERS = parseInt(__ENV.USERS || '50', 10);
const PASSWORD = 'k6Password123';
// setup이 끝난 뒤 모든 VU가 이 시간만큼 기다렸다가 같은 순간에 요청을 보낸다
const BARRIER_DELAY_MS = 3000;

const created = new Counter('reservation_created');
const conflict = new Counter('reservation_conflict');
const alreadyActive = new Counter('reservation_already_active');
const unexpected = new Counter('reservation_unexpected');

export const options = {
  setupTimeout: '180s',
  scenarios: {
    concurrent_reservation: {
      executor: 'per-vu-iterations',
      vus: USERS,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    reservation_created: ['count==1'],
    reservation_conflict: [`count==${USERS - 1}`],
    reservation_already_active: ['count==0'],
    reservation_unexpected: ['count==0'],
    // teardown에서 서버 상태를 다시 조회해 검증한 결과
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

function kstDate(offsetDays) {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
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
  const loginIds = Array.from({ length: USERS }, (_, i) => `prd04-${runId}-${i}`);

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

function findSlotStatus(token, chargerId, startAt) {
  const date = startAt.slice(0, 10);
  const slots = dataOf(http.get(`${BASE_URL}/api/v1/stations/${STATION_ID}/availability?date=${date}`,
    { headers: authHeaders(token) }), '예약 가능 시간 조회');
  const slot = slots.find((s) => s.chargerId === chargerId && Date.parse(s.startAt) === Date.parse(startAt));
  return slot ? slot.status : null;
}

function pickStartAt(token, chargerId) {
  if (__ENV.START_AT) {
    return __ENV.START_AT;
  }
  // 오늘 슬롯은 시간이 지나며 사라질 수 있어 내일 슬롯을 쓴다
  const slots = dataOf(http.get(`${BASE_URL}/api/v1/stations/${STATION_ID}/availability?date=${kstDate(1)}`,
    { headers: authHeaders(token) }), '예약 가능 시간 조회');
  const slot = slots.find((s) => s.chargerId === chargerId && s.status === 'enable');
  if (!slot) {
    fail(`충전기 ${chargerId}에 내일 비어 있는 슬롯이 없습니다. START_AT으로 지정하세요`);
  }
  return slot.startAt;
}

export function setup() {
  const { vehicleModel, chargerId } = pickTarget();
  const runId = Date.now().toString(36);
  const tokens = signUpAndLogin(runId, vehicleModel);
  const startAt = pickStartAt(tokens[0], chargerId);

  console.log(`PRD-04 run=${runId} station=${STATION_ID} charger=${chargerId} startAt=${startAt} `
    + `vehicle=${vehicleModel} users=${USERS}`);
  return { tokens, chargerId, startAt, goAt: Date.now() + BARRIER_DELAY_MS };
}

export default function (data) {
  const token = data.tokens[__VU - 1];

  const wait = data.goAt - Date.now();
  if (wait > 0) {
    sleep(wait / 1000);
  }

  const res = http.post(`${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ chargerId: data.chargerId, startAt: data.startAt }),
    {
      headers: authHeaders(token),
      // 409는 이 테스트에서 기대한 응답이라 http_req_failed에 넣지 않는다
      responseCallback: http.expectedStatuses(201, 409),
      tags: { name: 'POST /api/v1/reservations' },
    });

  let code = null;
  try {
    code = res.status === 201 ? null : res.json('error.code');
  } catch (e) {
    // 본문이 JSON이 아니면(타임아웃, 게이트웨이 오류 등) 아래에서 unexpected로 센다
  }
  if (res.status === 201) {
    created.add(1);
  } else if (res.status === 409 && code === 'RESERVATION_CONFLICT') {
    conflict.add(1);
  } else if (res.status === 409 && code === 'RESERVATION_ALREADY_ACTIVE') {
    alreadyActive.add(1);
  } else {
    unexpected.add(1);
    console.error(`예상하지 못한 응답 VU=${__VU}: ${res.status} ${res.body}`);
  }

  check(res, {
    '201 또는 409 RESERVATION_CONFLICT': () => res.status === 201
      || (res.status === 409 && code === 'RESERVATION_CONFLICT'),
  });
}

export function teardown(data) {
  const tags = { phase: 'verify' };

  // 50명 중 진행 중 예약을 가진 사용자가 정확히 1명인지
  const mine = http.batch(data.tokens.map((token) => ({
    method: 'GET',
    url: `${BASE_URL}/api/v1/reservations/me`,
    params: { headers: authHeaders(token) },
  })));
  const holders = mine
    .map((res) => res.json('data'))
    .filter((d) => d && d.state === 'RESERVED');
  check(holders, {
    '진행 중 예약을 가진 사용자는 1명': (h) => h.length === 1,
  }, tags);

  // 해당 슬롯이 예약된 상태(disable)로 보이는지
  const slotStatus = findSlotStatus(data.tokens[0], data.chargerId, data.startAt);
  check(slotStatus, {
    '대상 슬롯이 disable': (s) => s === 'disable',
  }, tags);

  const reservationId = holders.length === 1 ? holders[0].reservation.reservationId : null;
  console.log(`PRD-04 검증: 예약 보유자 ${holders.length}명, reservationId=${reservationId}, 슬롯=${slotStatus}`);

  const startsAtUtc = new Date(data.startAt).toISOString().replace('T', ' ').replace('Z', '');
  console.log('outbox 확인 SQL (기대값 1):\n'
    + 'SELECT COUNT(*) FROM outbox_events o\n'
    + '  JOIN reservations r ON o.aggregate_type = \'reservation\' AND o.aggregate_id = r.id\n'
    + ` WHERE o.event_type = 'ReservationCreated' AND r.charger_id = ${data.chargerId}`
    + ` AND r.starts_at = '${startsAtUtc}';`);
}
