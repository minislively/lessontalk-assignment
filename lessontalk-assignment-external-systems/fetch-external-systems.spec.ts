import { describe, it, expect, vi } from 'vitest';
import {
  VendorAStoresResponse,
  VendorABookingsResponse,
  VendorBXmlResponse,
  VendorCStoresResponse,
  VendorCBookingsResponse,
  MessagingAcceptResponse,
  MessagingResultResponse,
} from './type/ApiResponse.js';

vi.setConfig({ testTimeout: 100000 });

// 호출 샘플. 먼저 서버를 띄워야 한다 (npm run start:external-systems).
// 502 가 확률적으로 나므로 여기서는 최소한의 재시도만 뒀다. 실제 재시도 정책은 과제 범위다.
async function call(input: string, init?: RequestInit, attempts = 8): Promise<Response> {
  for (let i = 1; ; i++) {
    const response = await fetch(input, init);
    if (response.status !== 502 || i >= attempts) return response;
  }
}
const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const kstTodayCompact = kstToday.replaceAll('-', '');

describe('외부 시스템 호출 샘플', () => {
  it('VENDOR_A (8801) — 매장 목록을 먼저 받고, 매장×날짜 단위로 예약을 받는다', async () => {
    const storesResponse = await call('http://localhost:8801/stores');
    const storesBody: VendorAStoresResponse = await storesResponse.json();
    expect(storesBody.list.length).toBeGreaterThanOrEqual(1);

    const storeId = storesBody.list[0].storeId;
    const response = await call(`http://localhost:8801/bookings?storeId=${storeId}&date=${kstToday}&page=1`);
    const body: VendorABookingsResponse = await response.json();
    expect(body.list.every((b) => b.storeId === storeId)).toBe(true);
    expect(body.list.every((b) => b.startAt.startsWith(kstToday))).toBe(true);
    expect(body.list[0]).toHaveProperty('memberId');
    expect(body.list[0]).toHaveProperty('instructorId');
    expect(body.list[0]).toHaveProperty('instructorPhone');
  });

  it('VENDOR_A — storeId 없이 부르면 400 이 온다', async () => {
    const response = await call('http://localhost:8801/bookings?page=1');
    expect(response.status).toBe(400);
  });

  it('VENDOR_A — date 없이 부르면 400 이 온다', async () => {
    const response = await call('http://localhost:8801/bookings?storeId=A-1001&page=1');
    expect(response.status).toBe(400);
  });

  it('VENDOR_B (8802) — shopCode×searchDate(YYYYMMDD) 로 XML 을 받고, 체크인 없이 cancelYn 만 온다', async () => {
    const response = await call(`http://localhost:8802/bookings?shopCode=7701&searchDate=${kstTodayCompact}&page=1`);
    const body: VendorBXmlResponse = await response.text();
    expect(body.includes('<booking>')).toBe(true);
    expect(body.includes('<proPhone>')).toBe(true);
    expect(body.includes('<cancelYn>')).toBe(true);
    expect(body.includes('checkinYn')).toBe(false);
  });

  it('VENDOR_C (8803) — SHOP_ID·DATE 를 body 에 실어 POST 로 조회한다', async () => {
    const storesResponse = await call('http://localhost:8803/stores');
    const storesBody: VendorCStoresResponse = await storesResponse.json();
    const shopId = storesBody.shopList[0].SHOP_ID;

    const response = await call('http://localhost:8803/bookings', {
      method: 'POST',
      body: JSON.stringify({ SHOP_ID: shopId, DATE: kstToday, page: 1 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body: VendorCBookingsResponse = await response.json();
    expect(body.bookingList.every((b) => b.SHOP_ID === shopId)).toBe(true);
  });

  it('MESSAGING (8804) — 발송을 접수하고 접수 로그를 읽는다 (중복은 호출자 책임)', async () => {
    const response = await call('http://localhost:8804/messages', {
      method: 'POST',
      body: JSON.stringify({ recipientPhone: '01012345678', message: '레슨 종료 안내 샘플', referenceKey: 'sample-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(202);
    const body: MessagingAcceptResponse = await response.json();
    expect(body.messageId).toMatch(/^M/);

    const logResponse = await call('http://localhost:8804/messages?page=1');
    expect(logResponse.status).toBe(200);

    const resultResponse = await call(`http://localhost:8804/messages/${body.messageId}`);
    const result: MessagingResultResponse = await resultResponse.json();
    expect(['ACCEPTED', 'DELIVERED', 'FAILED']).toContain(result.status);
  });

  it('MESSAGING — 없는 messageId 는 404 가 온다', async () => {
    const response = await call('http://localhost:8804/messages/M000000');
    expect(response.status).toBe(404);
  });
});
