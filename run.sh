#!/usr/bin/env bash
# .env를 환경 변수로 읽은 뒤 k6를 실행한다. k6는 시스템 환경 변수를 __ENV로 읽는다
# 사용: ./run.sh scenarios/prd-04-concurrent-reservation.js [k6 옵션...]
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo ".env가 없습니다. cp .env.example .env 후 값을 채우세요" >&2
  exit 1
fi

set -a
source .env
set +a

exec k6 run "$@"
