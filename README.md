# Product Engineer 직무 과제

## 레슨 피드백 시스템 구축

- **제출 기한**: 과제 시작을 원하는 일자로부터 7일 이내
- **제출 방법**: zip 으로 압축 후 이메일로 제출 (`YYYYMMDD_이름.zip` 형식으로 제출, `node_modules` 와 빌드 산출물 제외)
- **AI 도구**: 사용 허용. 단 사용 기록 원본을 `HISTORY.md`(필요한 경우 HISTORY/* 경로 생성)로 제출, 결과물에 대한 이해도를 면접에서 확인합니다.
- **기술 스택**: 프론트는 React / Next.js / Angular 중 선택. 백엔드는 NestJS, DB는 PostgreSQL,  
단 백엔드는 다른 스택도 무방하나 선택한 이유가 있어야합니다.(이유는 `README.md` 에 기재)  
나머지 기술 스택은 자유입니다.
- **필수 파일**: `README.md`, `HISTORY.md`, `docker-compose.yml`, `.env.example`, `.git`
- **문의**: 과제 관련 문의는 채용 담당자에게 이메일로 연락 주세요.

## 1. 배경 및 과제 개요

레슨톡은 골프, 필라테스처럼 레슨을 운영하는 매장을 위한 레슨 피드백 서비스입니다.
매장에는 점주와 프로(강사)가 있고, 회원은 레슨을 예약해 수업을 받습니다.

주요 시나리오

- **레슨 데이터 수집**: 매장과 연결된 외부 예약 시스템에서 레슨 데이터를 수집합니다.
- **피드백 작성요청 메시지 발송**: 레슨 종료 시 담당 프로에게 피드백 작성 요청합니다.
- **피드백 작성**: 레슨에 대해 프로가 피드백을 작성하고, 회원이 열람합니다.

## 2. 제공물

레슨 예약 데이터에 대한 벤더 서버와 메시지 발송 서버를 코드로 제공합니다.

| 서비스 | 포트 | 역할 |
| --- | --- | --- |
| API 문서 (Swagger) | 8800 | 아래 4개 서비스의 전체 명세 |
| VENDOR_A | 8801 | 예약 데이터 제공 (JSON, camelCase) |
| VENDOR_B | 8802 | 예약 데이터 제공 (XML) |
| VENDOR_C | 8803 | 예약 데이터 제공 (JSON, UPPER_SNAKE) |
| MESSAGING | 8804 | 외부 메시지 발송 대행 |

**[`lessontalk-assignment-external-systems/README.md`](./lessontalk-assignment-external-systems/README.md)를 확인해주세요.** 

## 3. 필수 구현 요건

### 3-1. 레슨 데이터 수집

제공된 외부 시스템(`lessontalk-assignment-external-systems`)을 사용하여  
벤더로부터 레슨을 수집해 데이터로 저장합니다.

**요구사항**

- 벤더 확장성 고려
- 주기적으로 레슨 데이터 동기화 처리
- 벤더별로 다른 레슨 상태 처리

### 3-2. 회원가입, 로그인과 권한처리

매장, 점주, 프로(강사), 회원의 관계를 고려하여 역할모델을 설계하고 권한 제어가 가능하도록 합니다.

**요구사항**

- 소속되지 않은 매장의 프로 및 회원은 매장 데이터 접근 불가
- 한 사람이 여러 매장에 소속 가능
- 피드백 작성은 레슨을 담당한 프로와 점주만 가능

### 3-3. 피드백 작성요청 메시지 발송과 피드백 작성

레슨 종료 후 제공된 외부 시스템(lessontalk-assignment-external-systems)을 사용하여 메시지 발송처리를 하고, 피드백 작성이 가능하도록 합니다.

**요구사항**

- 레슨 종료 후 피드백 작성요청에 대한 메시지 발송 처리
- 종료된 레슨에 대한 피드백 작성

### 3-4. 프론트엔드

UI/UX의 시각적 완성도는 평가하지 않습니다. 스타일링은 최소한이어도 무방합니다.  
프론트엔드 설계(상태·데이터·권한을 다루는 구조)를 봅니다.

**요구사항**

- 회원가입
- 로그인
- 피드백 현황
- 피드백 작성
- 피드백 상세

### 3-5. 인프라와 실행

- **`docker compose up` 한 줄**로 과제 제출물 (서비스 + DB) 기동.
- **제공된 외부 시스템**: 같은 compose 또는 별도 기동 (별도면 실행 순서 기재).
- **`GET /health`**: 헬스 체크 필수. 나머지 엔드포인트 구성은 자유.
- **시드 데이터**: `docker compose up` 시 자동 투입. 아래 세 계정으로 바로 로그인할 수 있어야 합니다.
  - **회원** — `A-1001` 매장의 `한지우`(`010-0000-0001`)
  - **프로** — `A-1001` 매장의 `박프로`(`010-9000-0503`)
  - **점주** — `A-1001` 매장의 점주 (벤더가 주지 않는 정보이니 임의로 구성)
- **환경 변수**: `.env.example` 제공, DB 접속 정보 외 민감 정보 하드코딩 금지

## 4. 테스트

테스트 커버리지보다는 테스트 범위와 기준을 설계하는 과정을 봅니다.

- 단위 테스트
- 통합 테스트

## 5. 제출물 체크리스트

- [ ] `.git` 포함 zip 파일 (`YYYYMMDD_이름.zip`, `node_modules` 와 빌드 산출물 제외)
- [ ] `README.md`
- [ ] `HISTORY.md` — AI 사용 기록 원본 (필요한 경우 HISTORY/* 경로 생성)
- [ ] `docker-compose.yml` — 단독 실행 가능
- [ ] `.env.example`

```
├── README.md
├── HISTORY.md
├── docker-compose.yml
├── lessontalk-assignment-external-systems/   (제공물, 코드 수정 금지)
└── (구성 자유)
```

## 6. 참고 사항

**`README.md` 권장 구성**

- **실행 방법**: `docker compose up` 이후 확인 가능한 URL, 역할별 테스트 계정
- **기술 스택**: 선택한 스택과 이유 (권장 스택과 다를 경우 필수)
- **설계 결정**: 수집 / 권한 / 발송 각각의 선택과 트레이드오프, 인프라 구성 설명
- **프론트 설계**: 화면 구성과 그렇게 나눈 이유
- **구현하지 못한 것**: 시간 내에 마치지 못한 부분과 그 이유
- **더 했다면**: 현재 설계의 한계와 개선 방향

설계 결정에 정답은 없습니다. 트레이드오프를 인식하고 설명할 수 있으면 충분합니다.  
결과물 자체의 완성도보다는 요구사항을 어떻게 해석하고,구현 과정에서 어떤 판단을 내렸는지를 중요하게 봅니다.

## 7. 구현 설계

### 기술 스택

- API: Node.js + TypeScript 기반 모듈형 모놀리스
- Web: Next.js
- Database: PostgreSQL + Prisma
- 실행: Docker Compose

별도 Worker, Redis, Kafka를 두지 않고 API 프로세스의 주기 작업과 PostgreSQL 상태 테이블로 동기화·메시지 작업을 관리합니다. 과제 규모에서 인프라 복잡도를 줄이면서 재시도, 멱등성, 발송 상태를 DB에 남길 수 있기 때문입니다.

백엔드는 NestJS 권장안 대신 Node.js HTTP 서버를 선택했습니다. 이 과제의 API 표면이 작고 외부 연동·상태 머신의 핵심 로직을 프레임워크 추상화 없이 명시적으로 보여주는 편이 구현 의도와 실패 처리를 설명하기 쉽기 때문입니다. TypeScript 모듈 경계와 서비스 함수로 도메인을 분리해 NestJS로 교체할 수 있는 구조를 유지합니다.

### 프로젝트 구조

```text
apps/api/                              # API, 인증, 동기화, 피드백, 메시지
apps/web/                              # Next.js 웹 화면
prisma/schema.prisma                   # 도메인 모델과 제약 조건
prisma/seed.ts                         # 테스트 계정과 초기 매장
lessontalk-assignment-external-systems/ # 제공된 외부 시스템, 수정 금지
```

### 외부 예약 데이터 수집

VENDOR_A, VENDOR_B, VENDOR_C의 API 차이는 Adapter 경계에서 처리하고 API 내부에는 표준 레슨 모델만 전달합니다.

- VENDOR_A: camelCase JSON, `pageInfo.totalPage`, ISO8601
- VENDOR_B: XML, `hasNextPage`, `YYYYMMDD`, `cancelYn`
- VENDOR_C: UPPER_SNAKE JSON, POST, `totalPageCount`, `STATE`

오늘과 내일을 5분마다 매장·날짜 단위로 수집합니다. 502, 타임아웃, 네트워크 오류는 요청당 총 3회까지 재시도하고, 400/404/413 및 응답 형식 오류는 재시도하지 않습니다. 모든 페이지가 성공적으로 수집된 경우에만 동기화 완료로 기록합니다.

B/C의 날짜와 시간은 `Asia/Seoul` 현지 시각으로 해석하고 UTC로 저장합니다. VENDOR_C의 알 수 없는 상태값은 원본 상태와 함께 `UNKNOWN`으로 저장하며 피드백 및 메시지 대상에서 제외합니다. 완전한 동기화에서 사라진 예약은 `SOURCE_MISSING`으로 보존하고, 실패·불완전 동기화에서는 기존 레슨을 변경하지 않습니다.

예약의 고유 키는 `(vendor, externalBookingId)`입니다. 사용자 식별에는 정규화한 전화번호를 사용하며, 이름은 외부 표기 변동 때문에 사용하지 않습니다. 예약 수집만으로 매장 membership이나 권한을 자동 부여하지 않습니다.

### 인증과 권한

사용자는 매장별 `OWNER`, `INSTRUCTOR`, `MEMBER` membership을 가집니다. 한 사용자가 여러 매장에 소속될 수 있으며 매장 접근은 항상 membership으로 확인합니다.

- 회원: 자신의 레슨과 피드백만 조회
- 프로: 담당 레슨 조회 및 담당 종료 레슨 피드백 작성
- 점주: 소속 매장의 전체 레슨 조회 및 피드백 작성

세션 토큰은 DB에 해시로 저장하는 opaque token 방식이며 HttpOnly, SameSite=Lax 쿠키로만 전송하고 localStorage에는 저장하지 않습니다. DB 기반 세션을 선택한 이유는 로그아웃·만료 세션을 즉시 폐기할 수 있고 과제 범위에서 별도의 JWT 검증 계층이 필요하지 않기 때문입니다. 로컬 HTTP에서는 `COOKIE_SECURE=false`, 운영 HTTPS에서는 Secure 쿠키를 사용합니다. 브라우저 요청은 credential을 포함하고 API는 허용된 Origin과 CSRF 토큰을 검증합니다. ID 기반 API는 URL 매장과 실제 리소스 매장이 일치하는지 확인한 뒤 서비스 계층에서 membership과 역할을 검증합니다.

### 피드백과 메시지

`endAt`이 현재 시각보다 이전이고 취소·미확인·소스 누락 상태가 아닌 레슨만 피드백 작성 대상입니다. 담당 프로와 해당 매장 점주만 작성할 수 있고 회원은 읽기만 가능합니다.

메시지 요청은 레슨당 하나의 멱등 키를 가집니다. 외부 Messaging 서버의 `202`와 `ACCEPTED`는 접수 또는 처리 대기이므로 재발송하지 않습니다. 명시적인 502는 미접수로 보고 재시도하고, `FAILED`만 제한적으로 재발송합니다. 타임아웃이나 응답 유실은 수락 여부를 알 수 없으므로 `RECONCILE_REQUIRED`로 남기고 reference key로 확인하기 전까지 자동 재발송하지 않습니다.

### 실행 방법

```bash
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:3000
- API health: http://localhost:3001/health
- External Swagger: http://localhost:8800

시드 계정의 비밀번호는 모두 `password123`입니다.

| 역할 | 이름 | 전화번호 |
|---|---|---|
| 회원 | 한지우 | `010-0000-0001` |
| 프로 | 박프로 | `010-9000-0503` |
| 점주 | 점주 | `010-9000-0001` |

### 테스트와 알려진 제한

Adapter 변환·페이지네이션·상태 변환·전화번호·권한·피드백 종료 조건을 단위 테스트로 검증하고, PostgreSQL 및 외부 시스템을 포함한 통합 흐름을 검증합니다. 외부 Messaging 서버가 재기동되어 접수 이력을 잃은 모호한 발송은 중복 발송보다 안전한 `RECONCILE_REQUIRED` 상태로 남깁니다.

```bash
npm --prefix apps/api run test
API_BASE_URL=http://localhost:3001 npm --prefix apps/api run test:integration
npm --prefix apps/api run build
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```