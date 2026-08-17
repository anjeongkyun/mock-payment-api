# mock-payment-api

결제를 처리하는 실제 로직은 없습니다. 클라이언트가 이 API를 호출하면, 매번 무작위로 정상 처리, 지연, 타임아웃, 서비스 다운, 결제 거절 중 하나를 시뮬레이션합니다. 주문, 선불카드 충전 등 결제가 필요한 어떤 도메인 서비스에서도 그대로 붙여 쓸 수 있도록 범용 결제 게이트웨이(토스페이먼츠 같은) 형태의 추상화된 인터페이스로 만들었습니다.

목적은 이 API를 호출하는 클라이언트 코드가 네트워크 지연, 타임아웃, 중복 요청, 서비스 장애 같은 상황을 제대로 처리하는지 검증하는 것입니다.

## 실행하기

Node.js를 설치할 필요 없이 Docker만 있으면 됩니다.

```bash
docker run -p 8080:8080 ghcr.io/anjeongkyun/mock-payment-api:latest
```

Node.js(18 이상)가 이미 있다면 직접 실행해도 됩니다.

```bash
node server.js
```

기본 포트는 8080이고, `PORT` 환경변수로 바꿀 수 있습니다.

## API

### `POST /payments`

결제를 요청합니다.

**요청 헤더**

| 이름 | 필수 | 설명 |
|---|---|---|
| `Idempotency-Key` | 예 | 클라이언트가 생성하는 고유 키. 같은 키로 재요청하면 실제로 다시 처리하지 않고 최초 결과를 그대로 반환합니다. |
| `Content-Type` | 예 | `application/json` |

**요청 바디**

```json
{
  "referenceId": "order-123",
  "amount": 15000
}
```

`referenceId`는 이 결제를 호출한 쪽에서 의미를 부여하는 식별자입니다. 주문 ID일 수도, 충전 요청 ID일 수도 있습니다. 이 서비스는 그 의미를 알지 못하고 그대로 돌려줄 뿐입니다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `referenceId` | string | 예 | 호출한 쪽에서 정의하는 참조 식별자 |
| `amount` | number (양수) | 예 | 결제 금액 |

**응답: 이 API가 시뮬레이션하는 다섯 가지 상황**

요청마다 아래 중 하나가 무작위로 발생합니다. 각각의 발생 확률은 환경변수로 조정할 수 있습니다(아래 "카오스 비율 조정하기" 참고).

1. **정상 처리**: 즉시 `201`로 응답합니다.
   ```json
   { "paymentId": "pay_abc", "referenceId": "order-123", "amount": 15000, "status": "APPROVED" }
   ```
2. **지연 후 정상 처리**: 0.5초에서 2.5초 사이 지연된 뒤 위와 동일하게 `201`로 응답합니다.
3. **타임아웃에 가까운 지연**: 3초에서 5초 사이 지연된 뒤 정상 처리됩니다. 이 시나리오를 실제로 경험하려면(클라이언트가 응답을 받기 전에 포기하도록) 클라이언트 쪽 타임아웃을 2초에서 3초 정도로 짧게 잡아야 합니다.
4. **서비스 다운**: 즉시 `503`으로 응답합니다. 이 요청은 실제로 아무것도 처리되지 않은 것으로 취급하므로, 같은 `Idempotency-Key`로 재시도해도 캐시된 결과 없이 다시 처리를 시도합니다.
   ```json
   { "error": "SERVICE_UNAVAILABLE", "message": "Payment service is temporarily down." }
   ```
5. **결제 거절**: 정상적으로 처리는 됐지만 비즈니스 사유로 거절됩니다. `200`으로 응답합니다.
   ```json
   { "paymentId": "pay_abc", "referenceId": "order-123", "amount": 15000, "status": "DECLINED", "reason": "INSUFFICIENT_FUNDS" }
   ```

**에러 응답**

| 상황 | 상태 코드 | 응답 |
|---|---|---|
| `Idempotency-Key` 헤더가 없음 | `400` | `{ "error": "MISSING_IDEMPOTENCY_KEY" }` |
| 바디가 JSON 형식이 아님 | `400` | `{ "error": "INVALID_JSON" }` |
| `referenceId` 또는 `amount`가 없거나 잘못됨 | `400` | `{ "error": "INVALID_REQUEST" }` |
| 같은 `Idempotency-Key`를 다른 바디로 재사용함 | `422` | `{ "error": "IDEMPOTENCY_KEY_REUSE_MISMATCH" }` |
| 같은 `Idempotency-Key`로 처리가 아직 끝나지 않았는데 또 요청이 옴 | `409` | `{ "error": "REQUEST_IN_PROGRESS" }` |

### `GET /payments/:paymentId`

처리가 완료된 결제를 조회합니다(다운으로 실패한 요청은 애초에 처리된 적이 없으므로 조회되지 않습니다).

| 상태 | 응답 |
|---|---|
| 존재함 | `200` `{ "paymentId": "...", "referenceId": "...", "amount": 0, "status": "..." }` |
| 없음 | `404` `{ "error": "PAYMENT_NOT_FOUND" }` |

### `GET /health`

카오스 없이 항상 즉시 `200` `{ "status": "UP" }`을 반환합니다. "서비스 자체가 죽었는지"와 "이번 요청이 다운을 시뮬레이션한 것뿐인지"를 구분하는 용도입니다.

## 멱등성 동작

같은 `Idempotency-Key`로 요청이 왔을 때의 동작을 정리하면 다음과 같습니다.

- **같은 바디로 재요청** → 최초 처리 결과(정상 처리든 거절이든)를 그대로 반환합니다. 실제로 다시 처리하지 않습니다.
- **다른 바디로 재요청** → `422`를 반환합니다. 키 재사용을 오용으로 간주합니다.
- **처리가 끝나기 전에 동시에 재요청** → `409`를 반환합니다. 경쟁 상황이니 잠시 후 다시 시도해야 합니다.
- **서비스 다운(503)으로 실패한 요청의 같은 키로 재요청** → 캐시되지 않으므로 새로 처리를 시도합니다. 다운은 "아무것도 처리되지 않은 상태"와 같기 때문입니다.

## 카오스 비율 조정하기

다섯 가지 상황(정상/지연/타임아웃/다운/거절)이 발생하는 확률은 서버를 **실행할 때** 환경변수로 정합니다. 코드를 고칠 필요 없이, 컨테이너를 띄우는 명령에 환경변수만 추가하면 됩니다.

**Docker로 실행할 때**

```bash
docker run -p 8080:8080 \
  -e SUCCESS_RATE=0.5 \
  -e DOWN_RATE=0.2 \
  -e DECLINE_RATE=0.1 \
  ghcr.io/anjeongkyun/mock-payment-api:latest
```

**docker-compose를 쓸 때**는 `docker-compose.yml`의 `environment` 항목 값을 바꾸면 됩니다.

```yaml
services:
  mock-payment-api:
    environment:
      SUCCESS_RATE: "0.5"
      DOWN_RATE: "0.2"
```

**Node.js로 직접 실행할 때**는 환경변수를 앞에 붙여서 실행합니다.

```bash
SUCCESS_RATE=0.5 DOWN_RATE=0.2 node server.js
```

지정하지 않은 항목은 기본값을 씁니다. 다섯 개 비율의 합은 1.0이 되어야 정확히 의도한 확률로 동작합니다.

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `SUCCESS_RATE` | `0.6` | 즉시 정상 처리될 확률 |
| `LATENCY_RATE` | `0.2` | 지연 후 정상 처리될 확률 |
| `TIMEOUT_RATE` | `0.1` | 타임아웃에 가까운 지연이 발생할 확률 |
| `DOWN_RATE` | `0.05` | 즉시 서비스 다운(503)이 발생할 확률 |
| `DECLINE_RATE` | `0.05` | 결제가 거절될 확률 |
| `LATENCY_MIN_MS` / `LATENCY_MAX_MS` | `500` / `2500` | "지연 후 정상 처리" 시나리오의 지연 범위(밀리초) |
| `TIMEOUT_MIN_MS` / `TIMEOUT_MAX_MS` | `3000` / `5000` | "타임아웃에 가까운 지연" 시나리오의 지연 범위(밀리초) |
| `PORT` | `8080` | 리스닝 포트 |

예를 들어 실패 상황을 훨씬 자주 겪어보고 싶다면 이렇게 실행합니다.

```bash
docker run -p 8080:8080 \
  -e SUCCESS_RATE=0.3 -e LATENCY_RATE=0.2 -e TIMEOUT_RATE=0.2 -e DOWN_RATE=0.2 -e DECLINE_RATE=0.1 \
  ghcr.io/anjeongkyun/mock-payment-api:latest
```

## 참고

서버는 상태를 메모리에만 저장합니다. 재시작하면 멱등성 기록이 전부 사라집니다. 실제 결제 로직·PG 연동과는 무관한, 학습·테스트 용도의 목입니다.
