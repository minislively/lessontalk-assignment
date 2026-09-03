import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config', 'config.json');
const DEFAULTS = {
  vendorFailRate: 0.15,
  messagingFailRate: 0.15,
  messagingDeliveryFailRate: 0.10,
  messagingDeliveryDelayMs: 15_000,
  storesPerVendor: 6,
  mutateIntervalMs: 5 * 60_000,
  mutateTriggerMax: 0.30,
  mutatePortionMax: 0.03,
  vanishShareOfCancel: 0.35,
};
let config = { ...DEFAULTS };
function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) next[key] = value;
    }
    config = next;
  } catch (error) {
    console.error(`[external] config.json 을 읽지 못해 이전 값을 유지한다: ${error.message}`);
  }
}
loadConfig();
const STORES_PER_VENDOR = config.storesPerVendor;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

const STORE_NAMES = [
  '그린힐 골프아카데미', '스윙업 스튜디오', '버디존', '탑스핀 레슨센터',
  '코어핏 필라테스', '이글아이 아카데미', '페어웨이 랩', '밸런스룸',
  '드라이브존', '알바트로스 스튜디오', '핀시커 아카데미', '리커버리 짐',
  '온그린 아카데미', '스트라이드 필라테스', '레인지원', '티박스 스튜디오',
  '샷메이커 아카데미', '무브웰 스튜디오', '퍼팩트그린', '바디라인 필라테스',
  '롱드라이브 클럽', '어프로치 랩', '스윙랩 아카데미', '필라움 스튜디오',
];
let storeNameCursor = 0;
function nextStoreName() {
  const name = STORE_NAMES[storeNameCursor % STORE_NAMES.length];
  storeNameCursor += 1;
  return storeNameCursor > STORE_NAMES.length ? `${name} ${Math.ceil(storeNameCursor / STORE_NAMES.length)}호점` : name;
}
function makeStores(vendor) {
  return Array.from({ length: STORES_PER_VENDOR }, (_, i) => {
    const id =
      vendor === 'VENDOR_A' ? `A-${1001 + i}` :
      vendor === 'VENDOR_B' ? String(7701 + i) :
      `C-${String(5 + i).padStart(2, '0')}`;
    return { storeId: id, storeName: nextStoreName() };
  });
}
const stores = {
  VENDOR_A: makeStores('VENDOR_A'),
  VENDOR_B: makeStores('VENDOR_B'),
  VENDOR_C: makeStores('VENDOR_C'),
};
function findStore(vendor, storeId) {
  return stores[vendor].find((s) => s.storeId === storeId) ?? null;
}

const INSTRUCTOR_NAMES = [
  '박프로', '김프로', '이코치', '한프로', '정코치', '윤프로',
  '조코치', '임프로', '서프로', '최코치', '강프로', '오코치',
  '신프로', '권코치', '황프로', '안코치', '송프로', '류코치',
  '배프로', '남코치', '전프로', '고코치', '문프로', '양코치',
  '손프로', '백코치', '허프로', '나코치', '유프로', '봉코치',
  '표프로', '변코치', '노프로', '방코치', '심프로', '연코치',
];
function instructorName(index) {
  const base = INSTRUCTOR_NAMES[index % INSTRUCTOR_NAMES.length];
  const round = Math.floor(index / INSTRUCTOR_NAMES.length);
  return round === 0 ? base : `${base}${round + 1}`;
}
// 프로는 매장 전속이 원칙이다. 한 사람이 여러 매장을 도는 것은 현실에서 드물어
// 아래 두 명만 예외로 둔다.
//   겸업 ① 같은 벤더의 두 매장   (VENDOR_A 의 1번째 매장 ↔ 2번째 매장)
//   겸업 ② 서로 다른 벤더의 두 매장 (VENDOR_A 의 4번째 매장 ↔ VENDOR_B 의 2번째 매장)
const INSTRUCTORS_PER_STORE = 2;
const SAME_VENDOR_PAIR = [['VENDOR_A', 0], ['VENDOR_A', 1]];
const CROSS_VENDOR_PAIR = [['VENDOR_A', 3], ['VENDOR_B', 1]];
const INSTRUCTORS = Array.from(
  { length: STORES_PER_VENDOR * 3 * INSTRUCTORS_PER_STORE },
  (_, i) => {
    const serial = 500 + (i + 1) * 3;
    return { id: `T${serial}`, name: instructorName(i), phone: `010${String(90000000 + serial).padStart(8, '0')}` };
  },
);
const storeInstructors = new Map();
(function assignInstructors() {
  let cursor = 0;
  for (const vendor of Object.keys(stores)) {
    for (const store of stores[vendor]) {
      storeInstructors.set(`${vendor}:${store.storeId}`,
        Array.from({ length: INSTRUCTORS_PER_STORE }, () => INSTRUCTORS[cursor++]));
    }
  }
  // 겸업 프로를 두 번째 매장에도 배정한다. 매장 수가 적으면 지정한 인덱스가 없을 수 있으니
  // 있는 범위로 당겨 쓰고, 그래도 같은 매장이 되면 겸업을 만들 수 없으므로 알린다.
  const share = (label, [fromVendor, fromIndex], [toVendor, toIndex]) => {
    const from = stores[fromVendor][Math.min(fromIndex, stores[fromVendor].length - 1)];
    const to = stores[toVendor][Math.min(toIndex, stores[toVendor].length - 1)];
    if (from === undefined || to === undefined || (fromVendor === toVendor && from.storeId === to.storeId)) {
      console.warn(`[external] ${label} 겸업 프로를 배정할 매장이 부족하다 (storesPerVendor=${STORES_PER_VENDOR})`);
      return;
    }
    const fromList = storeInstructors.get(`${fromVendor}:${from.storeId}`);
    const toList = storeInstructors.get(`${toVendor}:${to.storeId}`);
    if (!toList.includes(fromList[0])) toList.push(fromList[0]);
  };
  share('같은 벤더', ...SAME_VENDOR_PAIR);
  share('다른 벤더', ...CROSS_VENDOR_PAIR);
})();
function instructorsOf(vendor, storeId) {
  return storeInstructors.get(`${vendor}:${storeId}`) ?? [];
}

const FAMILY = ['김', '이', '박', '최', '정', '한', '조', '윤', '임', '서'];
const GIVEN = ['민준', '서연', '지후', '하은', '도윤', '수아', '예준', '지민', '시우', '유나', '건우', '소율'];

let phoneSerial = 3000;
let memberSerial = 20000;
function newMember() {
  phoneSerial += 1 + Math.floor(Math.random() * 7);
  memberSerial += 1 + Math.floor(Math.random() * 3);
  return {
    id: `U${memberSerial}`,
    name: pick(FAMILY) + pick(GIVEN),
    phone: `010${String(phoneSerial).padStart(8, '0')}`,
  };
}
// 회원은 재기동할 때마다 새로 생성되므로 시드 계정을 미리 박아 둘 수가 없다.
// 그래서 이름과 전화가 절대 변하지 않는 회원 한 명을 고정으로 둔다.
// 이 회원은 아래 매장에 속하고 매 날짜마다 첫 번째 레슨을 배정받으며, 그 레슨의 담당 프로도
// 그 매장의 첫 번째 프로로 고정된다. 프로는 원래 결정적이므로 이것으로 회원·프로 양쪽의
// 시드 계정을 만들 수 있다. 표기 흔들림(접두·후행 공백)도 이 회원에게는 적용하지 않는다.
const ANCHOR_MEMBER = { id: 'U10001', name: '한지우', phone: '01000000001' };
const ANCHOR_VENDOR = 'VENDOR_A';
const ANCHOR_STORE_ID = stores[ANCHOR_VENDOR][0]?.storeId ?? null;
const isAnchorStore = (vendor, storeId) => vendor === ANCHOR_VENDOR && storeId === ANCHOR_STORE_ID;
// 예약 ID·시각·상태까지 재기동 사이에 같아야 하므로 일반 예약이 닿지 않는 번호대를 쓴다.
// 일반 예약은 100000 에서 시작해 건당 1~3 씩만 올라가므로 199000 대와 겹치지 않는다.
// 번호는 "시드 시점의 오늘"이 아니라 고정 기준일에서 유도해야 한다. 그래야 서버가 자정을
// 넘겨 새 날짜를 시드해도 어제 발급한 번호와 절대 겹치지 않고, 같은 날짜는 언제나 같은
// 번호를 갖는다.
const ANCHOR_BOOKING_BASE = 199001;
const ANCHOR_EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');
const anchorBookingId = (vendor, date) =>
  `${vendor.slice(-1)}${ANCHOR_BOOKING_BASE + Math.round((Date.parse(`${date}T00:00:00Z`) - ANCHOR_EPOCH_MS) / 86_400_000)}`;
const ANCHOR_START_MINUTES = 7 * 60;
const ANCHOR_LESSON_MINUTES = 15;

const memberPools = new Map();
function memberOf(vendor, storeId, anchor = false) {
  if (anchor) return { ...ANCHOR_MEMBER };
  const key = `${vendor}:${storeId}`;
  if (!memberPools.has(key)) {
    memberPools.set(key, Array.from({ length: 40 + Math.floor(Math.random() * 21) }, newMember));
  }
  const base = pick(memberPools.get(key));
  let name = base.name;
  if (chance(0.06)) name = `(J)${name}`;
  if (chance(0.05)) name = `${name} `;
  return { id: base.id, name, phone: base.phone };
}

const KST_OFFSET_MS = 9 * 3600_000;
function kstDateText(offsetDays) {
  return new Date(Date.now() + KST_OFFSET_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function pickLessonMinutes(roll) {
  if (roll < 0.5) return 15;
  if (roll < 0.7) return 20;
  if (roll < 0.9) return 25;
  return 30;
}
function timeText(totalMinutes) {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
const EARLIEST_START = 6 * 60;
const LATEST_START = 20 * 60 + 45;
let bookingSerial = 100000;
function newBooking(vendor, storeId, date, roll = Math.random(), anchor = false) {
  bookingSerial += 1 + Math.floor(Math.random() * 3);
  const m = memberOf(vendor, storeId, anchor);
  const roster = instructorsOf(vendor, storeId);
  const instructor = anchor ? roster[0] : pick(roster);
  const startTotal = anchor
    ? ANCHOR_START_MINUTES
    : (6 + Math.floor(Math.random() * 15)) * 60 + pick([0, 15, 30, 45]);
  const lessonMinutes = anchor ? ANCHOR_LESSON_MINUTES : pickLessonMinutes(roll);
  return {
    id: anchor ? anchorBookingId(vendor, date) : `${vendor.slice(-1)}${bookingSerial}`,
    storeId,
    memberId: m.id,
    memberName: m.name,
    memberPhone: m.phone,
    date,
    startTime: timeText(startTotal),
    endTime: timeText(startTotal + lessonMinutes),
    lessonMinutes,
    instructorId: instructor.id,
    instructorName: instructor.name,
    instructorPhone: instructor.phone,
    status: 'RESERVED',
    poisonState: anchor ? false : chance(0.02),
    vanished: false,
    anchor,
  };
}
const bookings = { VENDOR_A: [], VENDOR_B: [], VENDOR_C: [] };
const WINDOW_PAST_DAYS = 0;
const WINDOW_AHEAD_DAYS = 1;
const seeded = new Set();
function seedStoreDate(vendor, storeId, date) {
  const key = `${vendor}:${storeId}:${date}`;
  if (seeded.has(key)) return 0;
  seeded.add(key);
  const count = 14 + Math.floor(Math.random() * 8);
  for (let i = 0; i < count; i++) {
    // 고정 회원의 레슨은 시드 계정 확인용이므로 취소·체크인으로 흔들지 않는다.
    const anchor = i === 0 && isAnchorStore(vendor, storeId);
    const booking = newBooking(vendor, storeId, date, i / count, anchor);
    if (anchor) { bookings[vendor].push(booking); continue; }
    if (vendor !== 'VENDOR_B' && chance(0.18)) booking.status = 'CHECKED_IN';
    else if (chance(0.08)) booking.status = 'CANCELED';
    bookings[vendor].push(booking);
  }
  return count;
}
function seedWindow() {
  let added = 0;
  for (const vendor of Object.keys(bookings)) {
    for (const store of stores[vendor]) {
      for (let offset = -WINDOW_PAST_DAYS; offset <= WINDOW_AHEAD_DAYS; offset++) {
        added += seedStoreDate(vendor, store.storeId, kstDateText(offset));
      }
    }
  }
  return added;
}

function mutateTick() {
  seedWindow();
  if (Math.random() >= config.mutateTriggerMax) return;
  if (config.mutatePortionMax <= 0) return;
  for (const vendor of Object.keys(bookings)) {
    // 고정 회원의 레슨은 시드 계정 확인용이라 변동 대상에서 뺀다.
    const live = bookings[vendor].filter((b) => !b.vanished && !b.anchor);
    if (live.length === 0) continue;
    const budget = Math.max(1, Math.floor(live.length * Math.random() * config.mutatePortionMax));
    for (let i = 0; i < budget; i++) {
      const roll = Math.random();
      if (roll < 0.1) {
        const date = kstDateText(Math.floor(Math.random() * (WINDOW_PAST_DAYS + WINDOW_AHEAD_DAYS + 1)) - WINDOW_PAST_DAYS);
        bookings[vendor].push(newBooking(vendor, pick(stores[vendor]).storeId, date));
        continue;
      }
      const b = live[Math.floor(Math.random() * live.length)];
      if (roll < 0.3) {
        const current = Number(b.startTime.slice(0, 2)) * 60 + Number(b.startTime.slice(3));
        const shifted = current + (Math.random() < 0.5 ? 60 : -60);
        if (shifted < EARLIEST_START || shifted > LATEST_START) continue;
        b.startTime = timeText(shifted);
        b.endTime = timeText(shifted + b.lessonMinutes);
        continue;
      }
      if (roll < 0.5 && b.status === 'RESERVED') {
        const toCanceled = vendor === 'VENDOR_B' || Math.random() >= 0.6;
        if (toCanceled && chance(config.vanishShareOfCancel)) {
          b.vanished = true;
          continue;
        }
        b.status = toCanceled ? 'CANCELED' : 'CHECKED_IN';
      }
    }
  }
}

const hyphenate = (p) => `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function pageSlice(list, page, size) {
  const totalPage = Math.max(1, Math.ceil(list.length / size));
  return { items: list.slice((page - 1) * size, page * size), totalPage };
}
function storeBookings(vendor, storeId) {
  return bookings[vendor].filter((b) => b.storeId === storeId && !b.vanished);
}

function vendorAStores() {
  return JSON.stringify({ list: stores.VENDOR_A.map((s) => ({ storeId: s.storeId, storeName: s.storeName })) });
}
function vendorABookings(storeId, date, page) {
  const filtered = storeBookings('VENDOR_A', storeId).filter((b) => b.date === date);
  const { items, totalPage } = pageSlice(filtered, page, 10);
  return JSON.stringify({
    list: items.map((b) => ({
      bookingId: b.id,
      storeId: b.storeId,
      memberId: b.memberId,
      memberName: b.memberName,
      memberPhone: hyphenate(b.memberPhone),
      startAt: `${b.date}T${b.startTime}:00+09:00`,
      endAt: `${b.date}T${b.endTime}:00+09:00`,
      instructorId: b.instructorId,
      instructorName: b.instructorName,
      instructorPhone: hyphenate(b.instructorPhone),
      status: b.status,
    })),
    pageInfo: { totalPage },
  });
}

function vendorBStores() {
  const rows = stores.VENDOR_B.map((s) =>
    `    <store>\n      <shopCode>${s.storeId}</shopCode>\n      <shopName>${xmlEscape(s.storeName)}</shopName>\n    </store>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n  <list>\n${rows}\n  </list>\n</result>`;
}
function vendorBBookings(shopCode, date, page) {
  const filtered = storeBookings('VENDOR_B', shopCode).filter((b) => b.date === date);
  const { items, totalPage } = pageSlice(filtered, page, 5);
  const rows = items.map((b) => [
    '    <booking>',
    `      <bookingNo>${b.id}</bookingNo>`,
    `      <shopCode>${b.storeId}</shopCode>`,
    `      <custName>${xmlEscape(b.memberName)}</custName>`,
    `      <custPhone>${b.memberPhone}</custPhone>`,
    `      <lessonDate>${b.date}</lessonDate>`,
    `      <beginTime>${b.startTime}</beginTime>`,
    `      <finishTime>${b.endTime}</finishTime>`,
    `      <proName>${xmlEscape(b.instructorName)}</proName>`,
    `      <proPhone>${b.instructorPhone}</proPhone>`,
    `      <cancelYn>${b.status === 'CANCELED' ? 'Y' : 'N'}</cancelYn>`,
    '    </booking>',
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n  <list>\n${rows}\n  </list>\n  <hasNextPage>${page < totalPage}</hasNextPage>\n</result>`;
}

const C_STATE = { RESERVED: '1', CHECKED_IN: '2', CANCELED: '9' };
function vendorCStores() {
  return JSON.stringify({ shopList: stores.VENDOR_C.map((s) => ({ SHOP_ID: s.storeId, SHOP_NAME: s.storeName })) });
}
function vendorCBookings(shopId, date, page) {
  const filtered = storeBookings('VENDOR_C', shopId).filter((b) => b.date === date);
  const { items, totalPage } = pageSlice(filtered, page, 10);
  return JSON.stringify({
    bookingList: items.map((b) => ({
      BOOKING_ID: b.id,
      SHOP_ID: b.storeId,
      USER_NAME: b.memberName,
      PHONE: `+82${b.memberPhone.slice(1)}`,
      DATE: b.date,
      START_TIME: b.startTime,
      END_TIME: b.endTime,
      PRO_NAME: b.instructorName,
      PRO_PHONE: `+82${b.instructorPhone.slice(1)}`,
      STATE: b.poisonState ? '7' : C_STATE[b.status],
    })),
    page: { totalPageCount: totalPage },
  });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE_RE = /^\d{8}$/;
function isRealDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
function parseIsoDate(raw) {
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) return null;
  return isRealDate(raw) ? raw : null;
}
function parseCompactDate(raw) {
  if (typeof raw !== 'string' || !COMPACT_DATE_RE.test(raw)) return null;
  const text = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  return isRealDate(text) ? text : null;
}
function parsePage(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 1 ? raw : null;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 ? page : null;
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function respond(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, ...CORS_HEADERS });
  res.end(body);
}
function parseUrl(rawUrl, port) {
  try {
    return new URL(rawUrl, `http://localhost:${port}`);
  } catch {
    return null;
  }
}
function serve(port, serviceName, failRate, handler) {
  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    const url = parseUrl(req.url, port);
    if (url === null) return respond(res, 400, 'bad request line', 'text/plain');
    if (url.pathname === '/health') return respond(res, 200, '{"status":"ok"}', 'application/json');
    if (Math.random() < failRate()) return respond(res, 502, 'Bad Gateway', 'text/plain');
    handler(req, res, url).catch(() => respond(res, 500, 'internal', 'text/plain'));
  }).listen(port, '0.0.0.0', () => console.log(`[external] ${serviceName} listening on :${port}`));
}

const SPEC_NAMES = ['vendor-a', 'vendor-b', 'vendor-c', 'messaging'];
// 스펙의 예시 날짜는 자리표시자로 두고 응답할 때 채운다. 고정 날짜를 박아 두면
// 데이터가 있는 구간(오늘·내일) 밖이 되어 Swagger 의 Try it out 이 늘 빈 목록을 준다.
const specTexts = Object.fromEntries(
  SPEC_NAMES.map((name) => [name, readFileSync(join(HERE, 'specs', `${name}.json`), 'utf8')]),
);
function renderSpec(name) {
  return specTexts[name]
    .replaceAll('{{TODAY_COMPACT}}', kstDateText(0).replaceAll('-', ''))
    .replaceAll('{{TODAY}}', kstDateText(0))
    .replaceAll('{{TOMORROW}}', kstDateText(1));
}
for (const name of SPEC_NAMES) JSON.parse(renderSpec(name));

serve(8801, 'VENDOR_A', () => config.vendorFailRate, async (req, res, url) => {
  if (req.method === 'GET' && url.pathname === '/stores') return respond(res, 200, vendorAStores(), 'application/json');
  if (req.method === 'GET' && url.pathname === '/bookings') {
    const storeId = url.searchParams.get('storeId');
    if (storeId === null || storeId === '') return respond(res, 400, '{"message":"storeId 쿼리가 필요합니다"}', 'application/json');
    const date = parseIsoDate(url.searchParams.get('date'));
    if (date === null) return respond(res, 400, '{"message":"date 쿼리가 필요합니다 (YYYY-MM-DD)"}', 'application/json');
    const page = parsePage(url.searchParams.get('page'));
    if (page === null) return respond(res, 400, '{"message":"page must be a positive integer"}', 'application/json');
    if (findStore('VENDOR_A', storeId) === null) return respond(res, 404, '{"message":"unknown storeId"}', 'application/json');
    return respond(res, 200, vendorABookings(storeId, date, page), 'application/json');
  }
  respond(res, 404, '{"message":"not found"}', 'application/json');
});

serve(8802, 'VENDOR_B', () => config.vendorFailRate, async (req, res, url) => {
  if (req.method === 'GET' && url.pathname === '/stores') return respond(res, 200, vendorBStores(), 'application/xml');
  if (req.method === 'GET' && url.pathname === '/bookings') {
    const shopCode = url.searchParams.get('shopCode');
    if (shopCode === null || shopCode === '') return respond(res, 400, '<error>shopCode 쿼리가 필요합니다</error>', 'application/xml');
    const date = parseCompactDate(url.searchParams.get('searchDate'));
    if (date === null) return respond(res, 400, '<error>searchDate 쿼리가 필요합니다 (YYYYMMDD)</error>', 'application/xml');
    const page = parsePage(url.searchParams.get('page'));
    if (page === null) return respond(res, 400, '<error>page must be a positive integer</error>', 'application/xml');
    if (findStore('VENDOR_B', shopCode) === null) return respond(res, 404, '<error>unknown shopCode</error>', 'application/xml');
    return respond(res, 200, vendorBBookings(shopCode, date, page), 'application/xml');
  }
  respond(res, 404, '<error>not found</error>', 'application/xml');
});

serve(8803, 'VENDOR_C', () => config.vendorFailRate, async (req, res, url) => {
  if (req.method === 'GET' && url.pathname === '/stores') return respond(res, 200, vendorCStores(), 'application/json');
  if (req.method === 'POST' && url.pathname === '/bookings') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      // 본문 과다와 연결 중단을 구분한다. 둘 다 413 으로 뭉뚱그리면 원인을 오진하게 된다.
      if (error.tooLarge === true) return respond(res, 413, '{"message":"본문이 너무 큽니다"}', 'application/json');
      return respond(res, 400, '{"message":"본문을 읽지 못했습니다"}', 'application/json');
    }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { body = null; }
    if (body === null || typeof body !== 'object') {
      return respond(res, 400, '{"message":"본문이 올바른 JSON 이 아닙니다"}', 'application/json');
    }
    const shopId = typeof body.SHOP_ID === 'string' && body.SHOP_ID !== '' ? body.SHOP_ID : null;
    if (shopId === null) return respond(res, 400, '{"message":"SHOP_ID 가 필요합니다"}', 'application/json');
    const date = parseIsoDate(body.DATE);
    if (date === null) return respond(res, 400, '{"message":"DATE 가 필요합니다 (YYYY-MM-DD)"}', 'application/json');
    const page = parsePage(body.page);
    if (page === null) return respond(res, 400, '{"message":"page must be a positive integer"}', 'application/json');
    if (findStore('VENDOR_C', shopId) === null) return respond(res, 404, '{"message":"unknown SHOP_ID"}', 'application/json');
    return respond(res, 200, vendorCBookings(shopId, date, page), 'application/json');
  }
  respond(res, 404, '{"message":"not found"}', 'application/json');
});

const acceptedMessages = [];
const messageIndex = new Map();
let messageSerial = 900000;
const MAX_BODY_BYTES = 1_000_000;
function isPhoneLike(value) {
  if (typeof value !== 'string' || !/^\+?[0-9- ]{9,20}$/.test(value)) return false;
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 9 && digits.length <= 15;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        const tooLarge = new Error('body too large');
        tooLarge.tooLarge = true;
        reject(tooLarge);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  const url = parseUrl(req.url, 8804);
  if (url === null) return respond(res, 400, '{"message":"bad request line"}', 'application/json');
  if (url.pathname === '/health') return respond(res, 200, '{"status":"ok"}', 'application/json');
  if (Math.random() < config.messagingFailRate) return respond(res, 502, 'Bad Gateway', 'text/plain');

  if (req.method === 'POST' && url.pathname === '/messages') {
    readBody(req).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { body = null; }
      if (body === null || typeof body !== 'object') {
        return respond(res, 400, '{"message":"본문이 올바른 JSON 이 아닙니다"}', 'application/json');
      }
      const hasReference = body.referenceKey === undefined || typeof body.referenceKey === 'string';
      const isValid = isPhoneLike(body.recipientPhone)
        && typeof body.message === 'string' && body.message.trim().length > 0
        && hasReference;
      if (!isValid) {
        return respond(res, 400, '{"message":"recipientPhone(전화형식), message(공백이 아닌 문자열)가 필요하고 referenceKey 는 문자열이어야 합니다"}', 'application/json');
      }
      messageSerial += 1;
      const accepted = {
        messageId: `M${messageSerial}`,
        recipientPhone: body.recipientPhone,
        message: body.message,
        referenceKey: typeof body.referenceKey === 'string' ? body.referenceKey : null,
        acceptedAt: new Date().toISOString(),
        status: 'ACCEPTED',
        resolvedAt: null,
        failureReason: null,
      };
      acceptedMessages.push(accepted);
      messageIndex.set(accepted.messageId, accepted);
      setTimeout(() => {
        const failed = chance(config.messagingDeliveryFailRate);
        accepted.status = failed ? 'FAILED' : 'DELIVERED';
        accepted.resolvedAt = new Date().toISOString();
        accepted.failureReason = failed ? pick(['UNREACHABLE_NUMBER', 'CARRIER_REJECTED', 'DEVICE_UNAVAILABLE']) : null;
      }, config.messagingDeliveryDelayMs * (0.5 + Math.random()));
      setTimeout(() => {
        // 호출자가 이 지연 사이에 timeout 으로 끊으면 소켓이 이미 닫혀 있다.
        if (res.writableEnded || res.destroyed) return;
        respond(res, 202, JSON.stringify({ messageId: accepted.messageId, acceptedAt: accepted.acceptedAt }), 'application/json');
      }, Math.floor(Math.random() * 300));
    }).catch((error) => {
      if (error.tooLarge === true) return respond(res, 413, '{"message":"본문이 너무 큽니다"}', 'application/json');
      respond(res, 400, '{"message":"본문을 읽지 못했습니다"}', 'application/json');
    });
    return;
  }

  const single = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && single !== null) {
    const found = messageIndex.get(single[1]);
    if (found === undefined) return respond(res, 404, '{"message":"unknown messageId"}', 'application/json');
    return respond(res, 200, JSON.stringify(found), 'application/json');
  }

  if (req.method === 'GET' && url.pathname === '/messages') {
    const page = parsePage(url.searchParams.get('page'));
    if (page === null) return respond(res, 400, '{"message":"page must be a positive integer"}', 'application/json');
    const { items, totalPage } = pageSlice(acceptedMessages, page, 20);
    return respond(res, 200, JSON.stringify({ list: items, pageInfo: { totalPage, totalCount: acceptedMessages.length } }), 'application/json');
  }

  respond(res, 404, '{"message":"not found"}', 'application/json');
}).listen(8804, '0.0.0.0', () => console.log('[external] MESSAGING listening on :8804'));


const swaggerHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>레슨톡 과제 외부 시스템 API 문서</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      dom_id: '#swagger-ui',
      urls: [
        { url: '/specs/vendor-a.json', name: 'VENDOR_A (8801)' },
        { url: '/specs/vendor-b.json', name: 'VENDOR_B (8802)' },
        { url: '/specs/vendor-c.json', name: 'VENDOR_C (8803)' },
        { url: '/specs/messaging.json', name: 'MESSAGING (8804)' },
      ],
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
    });
  </script>
</body>
</html>`;

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  const url = parseUrl(req.url, 8800);
  if (url === null) return respond(res, 400, 'bad request line', 'text/plain');
  if (url.pathname === '/health') return respond(res, 200, '{"status":"ok"}', 'application/json');
  if (url.pathname === '/' || url.pathname === '/docs') return respond(res, 200, swaggerHtml, 'text/html; charset=utf-8');
  const matched = /^\/specs\/([a-z-]+)\.json$/.exec(url.pathname);
  if (matched !== null && Object.hasOwn(specTexts, matched[1])) return respond(res, 200, renderSpec(matched[1]), 'application/json');
  respond(res, 404, 'not found', 'text/plain');
}).listen(8800, '0.0.0.0', () => console.log('[external] API docs (Swagger) listening on :8800'));

process.on('uncaughtException', (error) => {
  console.error(`[external] uncaught: ${error.stack ?? error}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[external] unhandled rejection: ${reason}`);
});

seedWindow();
setInterval(loadConfig, 3_000);
function scheduleMutate() {
  setTimeout(() => {
    try {
      mutateTick();
    } catch (error) {
      console.error(`[external] mutate 실패: ${error.stack ?? error}`);
    }
    scheduleMutate();
  }, config.mutateIntervalMs);
}
scheduleMutate();
const total = Object.values(bookings).reduce((sum, list) => sum + list.length, 0);
console.log(`[external] seeded ${total} bookings across ${STORES_PER_VENDOR * 3} stores (dates ${kstDateText(-WINDOW_PAST_DAYS)}..${kstDateText(WINDOW_AHEAD_DAYS)}, KST)`);
