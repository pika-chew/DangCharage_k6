-- PRD-05 판정 SQL. ①~⑤가 전부 0건이면 합격
-- k6 teardown이 출력한 SET 줄을 먼저 실행해 @t0(테스트 시작 시각, UTC)를 정한다
--   SET @t0 = '2026-10-19 01:00:00.000';
-- 시각은 DB에 UTC로 저장된다. 손으로 넣을 때는 KST에서 9시간을 뺀다

-- ① 예약은 있는데 생성 이벤트가 없음
SELECT '① 생성 이벤트 없는 예약' AS q, r.id
FROM reservations r
LEFT JOIN outbox_events o ON o.aggregate_type = 'reservation' AND o.aggregate_id = r.id
                         AND o.event_type = 'ReservationCreated'
WHERE r.created_at >= @t0 AND o.id IS NULL;

-- ② 취소 상태인데 취소 이벤트가 없음
SELECT '② 취소 이벤트 없는 취소 예약' AS q, r.id
FROM reservations r
LEFT JOIN outbox_events o ON o.aggregate_type = 'reservation' AND o.aggregate_id = r.id
                         AND o.event_type = 'ReservationCanceled'
WHERE r.created_at >= @t0 AND r.status = 'CANCELLED' AND o.id IS NULL;

-- ③ 취소 이벤트는 있는데 예약 상태가 취소가 아님
SELECT '③ 취소 안 된 예약의 취소 이벤트' AS q, o.aggregate_id
FROM outbox_events o
JOIN reservations r ON r.id = o.aggregate_id
WHERE o.aggregate_type = 'reservation' AND o.event_type = 'ReservationCanceled'
  AND o.occurred_at >= @t0 AND r.status <> 'CANCELLED';

-- ④ 이벤트는 있는데 예약 자체가 없음
SELECT '④ 예약 없는 이벤트' AS q, o.id
FROM outbox_events o
LEFT JOIN reservations r ON r.id = o.aggregate_id
WHERE o.aggregate_type = 'reservation' AND o.occurred_at >= @t0 AND r.id IS NULL;

-- ⑤ 멱등성 키가 없는 예약을 가리킴
SELECT '⑤ 없는 예약을 가리키는 멱등성 키' AS q, k.id
FROM reservation_idempotency_keys k
LEFT JOIN reservations r ON r.id = k.reservation_id
WHERE k.created_at >= @t0 AND r.id IS NULL;

-- 한 번에 보기: 다섯 개 모두 0이어야 한다
SELECT
  (SELECT COUNT(*) FROM reservations r
     LEFT JOIN outbox_events o ON o.aggregate_type = 'reservation' AND o.aggregate_id = r.id
                              AND o.event_type = 'ReservationCreated'
    WHERE r.created_at >= @t0 AND o.id IS NULL) AS q1_no_created_event,
  (SELECT COUNT(*) FROM reservations r
     LEFT JOIN outbox_events o ON o.aggregate_type = 'reservation' AND o.aggregate_id = r.id
                              AND o.event_type = 'ReservationCanceled'
    WHERE r.created_at >= @t0 AND r.status = 'CANCELLED' AND o.id IS NULL) AS q2_no_canceled_event,
  (SELECT COUNT(*) FROM outbox_events o JOIN reservations r ON r.id = o.aggregate_id
    WHERE o.aggregate_type = 'reservation' AND o.event_type = 'ReservationCanceled'
      AND o.occurred_at >= @t0 AND r.status <> 'CANCELLED') AS q3_canceled_event_not_cancelled,
  (SELECT COUNT(*) FROM outbox_events o LEFT JOIN reservations r ON r.id = o.aggregate_id
    WHERE o.aggregate_type = 'reservation' AND o.occurred_at >= @t0 AND r.id IS NULL) AS q4_event_without_reservation,
  (SELECT COUNT(*) FROM reservation_idempotency_keys k LEFT JOIN reservations r ON r.id = k.reservation_id
    WHERE k.created_at >= @t0 AND r.id IS NULL) AS q5_dangling_idempotency_key;

-- 참고: 테스트 동안 쌓인 양. 예약·이벤트 수가 0이면 부하가 DB까지 가지 않은 것이다
SELECT
  (SELECT COUNT(*) FROM reservations WHERE created_at >= @t0) AS reservations,
  (SELECT COUNT(*) FROM reservations WHERE created_at >= @t0 AND status = 'CANCELLED') AS cancelled,
  (SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'reservation' AND occurred_at >= @t0
      AND event_type = 'ReservationCreated') AS created_events,
  (SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'reservation' AND occurred_at >= @t0
      AND event_type = 'ReservationCanceled') AS canceled_events;

-- (선택) Relay가 전부 보냈는지. 테스트가 끝나고 몇 초 뒤 0이어야 한다
SELECT COUNT(*) AS unsent FROM outbox_events WHERE sent_at IS NULL AND occurred_at >= @t0;
