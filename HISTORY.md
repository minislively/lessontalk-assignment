# AI 사용 기록

이 과제의 설계와 구현 과정에서 GJC Code를 사용했습니다.

- 과제 README와 외부 시스템 README/API 타입을 분석하고 서비스 범위, 데이터 모델, 권한, 동기화, 메시지 발송 정책을 설계했습니다.
- RALPLAN을 사용해 Planner·Architect·Critic 검토를 수행하고 최종 구현 설계를 확정했습니다.
- Ultragoal을 사용해 API, PostgreSQL/Prisma, Next.js, Docker Compose 구현 작업을 관리했습니다.
- 구현 과정에서 외부 시스템의 502 재시도, XML/JSON 벤더 차이, 전화번호 정규화, 피드백 권한, 메시지 중복 방지와 CSRF 쿠키 처리를 반영했습니다.
- 최종 결과는 담당자가 이해하고 설명할 수 있도록 설계 결정과 트레이드오프를 README에 기록했습니다.
