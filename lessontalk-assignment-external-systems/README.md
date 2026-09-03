# external-systems (외부 시스템 서버)

레슨 예약 데이터에 대한 벤더 서버와 발송 서비스입니다.  
이 폴더의 코드는 수정하지 마세요.

## 실행

```bash
docker compose up -d              # 8800~8804 전체 기동
# 또는
npm run start:external-systems         # node index.mjs, 외부 의존성 없음 (Node 22+)
```

## 동작
서버를 실행하는 순간 벤더마다 각 매장의 예약 데이터는 이미 쌓여 있습니다.  
- 예약은 금일과 명일에 대해 조회가 가능합니다.  
- 모든 예약 데이터는 시작·종료 시각을 가집니다.
- 5분마다 데이터가 업데이트될 수 있습니다. 새 예약이 추가되고, 예약 시간이 바뀌고, 예약 상태가 변합니다. 경우에 따라 예약데이터가 사라질 수도 있습니다.
- 모든 API 가 확률적으로 502를 응답합니다. `GET /health` 와 preflight(OPTIONS), 그리고 문서
  서버(8800)는 예외입니다.
- `page` 는 1 이상의 정수만 받습니다. 생략하면 1 이고, 그 밖의 값에 대해서는 400을 응답합니다.
- 날짜는 형식이 맞아야 하고 달력에 없는 날짜(`2026-13-45` 같은)는 400을 응답합니다.
- 선언되지 않은 경로나 메서드는 404를 응답합니다.

## 수집 벤더 3종

예약 조회는 매장과 날짜를 함께 지정해야 합니다.  
전체를 한 번에 받을 수 없고, 파라미터 이름과
날짜 표기도 벤더마다 다릅니다.  
필수값이 없거나 형식이 틀리면 400을, 없는 매장은 404를 응답합니다.  
조회날짜에 예약이 없으면 빈 목록을 반환합니다.

| 벤더 | 포트 | 매장 목록 | 예약 목록 | 형태 | 페이징 | 전화 표기 | 상태 표현 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VENDOR_A | 8801 | `GET /stores` | `GET /bookings?storeId=A-1001&date=YYYY-MM-DD&page=N` | JSON(camel) | `pageInfo.totalPage` (10건/쪽) | `010-1234-5678` | `status` 문자열 |
| VENDOR_B | 8802 | `GET /stores` | `GET /bookings?shopCode=7701&searchDate=YYYYMMDD&page=N` | XML | `hasNextPage` (5건/쪽) | `01012345678` | `cancelYn` 만, 체크인 개념 없음 |
| VENDOR_C | 8803 | `GET /stores` | `POST /bookings` body `{"SHOP_ID":"C-05","DATE":"YYYY-MM-DD","page":N}` | JSON(UPPER) | `page.totalPageCount` (10건/쪽) | `+821012345678` | `STATE` 숫자 코드 문자열 |

- VENDOR_B 의 `searchDate` 는 하이픈 없는 `YYYYMMDD` 인데 응답의 `lessonDate` 는 `yyyy-MM-dd`
  입니다. 요청과 응답의 날짜 표기가 다릅니다.
- 회원과 프로(강사)의 전화번호는 세 벤더에서 모두 제공합니다.  
- 반면 식별자
  (`memberId`, `instructorId`)를 주는 것은 VENDOR_A 뿐입니다.
- 프로는 대부분 한 매장 전속이고 **두 명만 두 매장에서 레슨합니다.** 한 명은 같은 벤더의 두
  매장, 다른 한 명은 서로 다른 두 벤더의 매장입니다. 전화번호를 정규화해야 찾을 수 있습니다.
- VENDOR_B 는 행이 있으면 예약이고 `cancelYn=Y` 면 취소입니다.
- 각 외부 시스템의 응답 상세는 [`Swagger`](http://localhost:8800) 또는 [`type/ApiResponse.ts`](./type/ApiResponse.ts) 를 확인해주세요.

## 메시지 발송 서비스 (MESSAGING, :8804)

메시지 발송을 위탁하는 외부 서비스입니다.

- `POST /messages` body `{recipientPhone, message, referenceKey?}` → `202 {messageId, acceptedAt}`
  - `202` 는 접수됐다는 뜻이고 수신자에게 도달했다는 뜻이 아닙니다.
  - 중복을 걸러 주지 않습니다. 같은 건을 두 번 접수하면 수신자가 두 번 받습니다.
  - `referenceKey` 는 접수 로그에 그대로 남깁니다.
  - 접수 응답에 0~300ms 지연이 있을 수 있습니다.
- `GET /messages/{messageId}` 로 도달 여부를 봅니다. 접수 직후에는 `ACCEPTED` 이고 수십 초
  안에 `DELIVERED` 또는 `FAILED` 로 확정됩니다.
  - `FAILED` 는 수신자가 못 받은 것이니 다시 보내는 게 맞습니다. 반대로 `ACCEPTED` 를 실패로
    오해해 다시 보내면 수신자가 두 번 받습니다.
- `GET /messages?page=N` 은 접수 로그를 접수 순으로 보여줍니다. 중복 접수는 중복으로 보이고,
  각 건의 `status` 와 전체 `totalCount` 가 함께 실립니다.
- **502 로 실패한 요청은 접수되지 않은 것이라 접수 로그에도 남지 않습니다.** 502 를 받고
  다시 보내는 것은 중복이 아닙니다. 반면 202 를 받고 다시 보내면 중복입니다.
- **접수 로그와 발송 상태는 메모리에만 있습니다.** 서버를 재기동하면 전부 사라집니다.

## 설정 (`config/config.json`)



| 키 | 기본값 | 의미 |
| --- | --- | --- |
| `vendorFailRate` | 0.15 | 수집 벤더(8801~8803)의 502 확률 |
| `messagingFailRate` | 0.15 | 발송 접수(8804)의 502 확률 |
| `messagingDeliveryFailRate` | 0.1 | 접수된 발송이 결국 `FAILED` 로 끝날 확률 |
| `messagingDeliveryDelayMs` | 15000 | 도달 여부가 확정되기까지의 기준 지연 (ms, ±50%) |
| `storesPerVendor` | 6 | 벤더당 매장 수. 올리면 수집량이 비례해 늘어납니다. 이 값만 재기동해야 반영됩니다 |
| `mutateIntervalMs` | 300000 | 데이터 변동 점검 주기 (ms) |
| `mutateTriggerMax` | 0.3 | 한 번 점검할 때 변동이 발동할 확률. `1` 이면 매번, `0` 이면 데이터가 고정됩니다 |
| `mutatePortionMax` | 0.03 | 발동했을 때 손댈 예약 비중의 상한. `0` 이면 아무것도 바뀌지 않습니다 |
| `vanishShareOfCancel` | 0.35 | 취소를 행 삭제로 표현할 비율. 나머지는 상태값 변경 |
