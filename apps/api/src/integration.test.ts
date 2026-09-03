import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.API_BASE_URL ?? 'http://localhost:3002';

async function login(phone: string) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ phone, password: 'password123' }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie().map((value) => value.split(';', 1)[0]);
  const csrf = cookies.find((value) => value.startsWith('lessontalk_csrf='))?.split('=', 2)[1];
  assert.ok(csrf);
  return { cookie: cookies.join('; '), csrf };
}

test('compose API exposes health and seeded member session', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const session = await login('010-0000-0001');
  const me = await fetch(`${base}/auth/me`, { headers: { cookie: session.cookie } });
  assert.equal(me.status, 200);
  const payload = await me.json() as { memberships: unknown[] };
  assert.equal(payload.memberships.length, 1);
});

test('tenant and input validation reject unsafe requests', async () => {
  const session = await login('010-0000-0001');
  const foreign = await fetch(`${base}/stores/A-1002/lessons`, { headers: { cookie: session.cookie } });
  assert.equal(foreign.status, 403);

  const invalidDate = await fetch(`${base}/stores/A-1001/lessons?date=2026-13-45`, { headers: { cookie: session.cookie } });
  assert.equal(invalidDate.status, 400);

  const selfJoin = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ name: 'Self Join', phone: '010-7777-7799', password: 'password123', storeId: 'A-1002' }),
  });
  assert.equal(selfJoin.status, 400);

  const missingCsrf = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie: session.cookie, origin: 'http://localhost:3000' } });
  assert.equal(missingCsrf.status, 403);
});
