# Final Architecture Review

## Verdict

- Architecture: CLEAR
- Product: CLEAR for the assignment acceptance surface
- Code: CLEAR with documented take-home limitations
- Recommendation: APPROVE

## Evidence

The current committed implementation is a modular Node/TypeScript API with PostgreSQL/Prisma persistence, a Next.js web client, untouched supplied external systems, and a root Compose topology. Vendor A/B/C adapters normalize JSON/XML, pagination, status, phone numbers, and Asia/Seoul local times. Backend routes enforce authentication, Origin/CSRF, membership, resource-store scope, role, lesson completion, and status rules. Messaging records requests and attempts, distinguishes 202/ACCEPTED from 502/FAILED, and avoids blind resend for ambiguous submissions.

Current verification is recorded in `artifacts/final-qa-report.json`: API unit 3 passed, API integration 3 passed, API build passed, Web typecheck/build passed, external contract tests 7 passed, Prisma validation passed, Compose configuration passed, all Compose services healthy, and `/health` returned 200.

## Review checks

- Login returns a cookie session and the web hydrates memberships through `/auth/me`.
- Explicit local `COOKIE_SECURE=false` prevents Secure cookies over local HTTP; production defaults remain Secure.
- Authenticated mutations require an allowlisted Origin and matching CSRF token.
- Public registration cannot self-assign a store membership.
- Owner sync/process/reconciliation operations are scoped to the owner's store memberships.
- Invalid JSON, null bodies, invalid calendar dates, unsupported lesson statuses, and foreign store access return client errors rather than leaking internal errors.
- Sync failures preserve existing lessons and repeated syncs do not duplicate `(vendor, externalBookingId)` rows.
- Web status filtering and session/store cache invalidation are aligned with API statuses.

## Limitations

The provided external service intentionally randomizes failures and stores message history in memory, so deterministic response-loss and provider-restart scenarios are not induced in every run. The persistent local database volume was not destructively reset; seed behavior is validated through the running seeded service. API host port 3001 may be overridden with `API_HOST_PORT` when occupied.
