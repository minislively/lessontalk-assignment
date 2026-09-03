import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://lessontalk:lessontalk@localhost:5432/lessontalk';

const { normalizeKoreanPhone, kstToUtc } = await import('./main.js');

test('normalizes Korean phone formats to local digits', () => {
  assert.equal(normalizeKoreanPhone('010-9000-0503'), '01090000503');
  assert.equal(normalizeKoreanPhone('+821090000503'), '01090000503');
});

test('converts vendor local KST time to UTC', () => {
  assert.equal(kstToUtc('2026-09-03', '07:00').toISOString(), '2026-09-02T22:00:00.000Z');
});

test('rejects invalid calendar values', () => {
  assert.throws(() => kstToUtc('2026-13-45', '07:00'));
});
