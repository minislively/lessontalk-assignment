import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { URL, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  PrismaClient,
  Vendor,
  PersonType,
  MembershipRole,
  LessonStatus,
  FeedbackRequestStatus,
  MessageAttemptStatus,
  SyncRunStatus,
} from '@prisma/client';

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT ?? 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;
const COOKIE_NAME = process.env.COOKIE_NAME ?? 'lessontalk_session';
const CSRF_COOKIE_NAME = 'lessontalk_csrf';
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const VENDOR_URLS: Record<Vendor, string> = {
  VENDOR_A: process.env.VENDOR_A_URL ?? 'http://localhost:8801',
  VENDOR_B: process.env.VENDOR_B_URL ?? 'http://localhost:8802',
  VENDOR_C: process.env.VENDOR_C_URL ?? 'http://localhost:8803',
};
const MESSAGING_URL = process.env.MESSAGING_URL ?? 'http://localhost:8804';
const SYNC_WORKER_ID = `api-${process.pid}-${randomBytes(5).toString('hex')}`;

interface AuthUser { id: string; name: string; phoneNormalized: string; }
interface AuthContext { user: AuthUser; sessionId: string; }
interface CanonicalLesson {
  externalBookingId: string;
  externalStoreId: string;
  memberExternalId?: string;
  memberName: string;
  memberPhone: string;
  instructorExternalId?: string;
  instructorName: string;
  instructorPhone: string;
  startAt: Date;
  endAt: Date;
  status: LessonStatus;
  rawStatus: string;
}
class ExternalError extends Error {
  constructor(public readonly status: number | undefined, message: string, public readonly ambiguous = false) { super(message); }
}

export function normalizeKoreanPhone(value: string): string {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (digits.startsWith('82')) return `0${digits.slice(2)}`;
  return digits;
}

function isValidPhone(value: string): boolean {
  const normalized = normalizeKoreanPhone(value);
  return /^01[0-9]\d{7,8}$/.test(normalized);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const expected = Buffer.from(parts[2], 'hex');
    const actual = (await scrypt(password, parts[1], expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function tokenHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function escapeCookie(value: string): string { return encodeURIComponent(value); }
function cookieHeader(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const attrs = [`${name}=${escapeCookie(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) attrs.push('HttpOnly');
  if (COOKIE_SECURE) attrs.push('Secure');
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  return attrs.join('; ');
}
function clearCookieHeader(name: string, httpOnly: boolean): string { return cookieHeader(name, '', 0, httpOnly); }
function parseCookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
function sendError(res: ServerResponse, status: number, message: string) { send(res, status, { error: message }); }
function requestOrigin(req: IncomingMessage): string | undefined {
  const value = req.headers.origin;
  return typeof value === 'string' ? value : undefined;
}
function isMutation(req: IncomingMessage): boolean { return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? ''); }
function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = requestOrigin(req);
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin && ALLOWED_ORIGINS.length === 1) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Vary', 'Origin');
}
function checkOrigin(req: IncomingMessage): boolean {
  const origin = requestOrigin(req);
  return !origin || ALLOWED_ORIGINS.includes(origin);
}
function checkCsrf(req: IncomingMessage): boolean {
  const cookies = parseCookies(req);
  const header = req.headers['x-csrf-token'];
  return typeof header === 'string' && Boolean(cookies[CSRF_COOKIE_NAME]) && header === cookies[CSRF_COOKIE_NAME];
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1_000_000) throw new ExternalError(413, 'request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new ExternalError(400, 'invalid JSON body'); }
}

async function authenticate(req: IncomingMessage): Promise<AuthContext | null> {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: tokenHash(raw), }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return { sessionId: session.id, user: { id: session.user.id, name: session.user.name, phoneNormalized: session.user.phoneNormalized } };
}

async function createSession(user: AuthUser): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { tokenHash: tokenHash(raw), userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  return raw;
}
async function requireAuth(req: IncomingMessage, res: ServerResponse): Promise<AuthContext | null> {
  const auth = await authenticate(req);
  if (!auth) sendError(res, 401, 'authentication required');
  return auth;
}

function kstDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function kstToUtc(dateText: string, timeText: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(timeText)) throw new Error('invalid local datetime');
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute, second = 0] = timeText.split(':').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || minute > 59 || second > 59 || hour > 24 || (hour === 24 && (minute !== 0 || second !== 0))) throw new Error('invalid local datetime');
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 60 * 60 * 1000;
  const result = new Date(utcMillis);
  if (Number.isNaN(result.getTime())) throw new Error('invalid local datetime');
  return result;
}
function isValidDateText(value: string): boolean {
  try { kstToUtc(value, '00:00'); return true; } catch { return false; }
}
function dayBounds(dateText: string): { start: Date; end: Date } {
  return { start: kstToUtc(dateText, '00:00'), end: kstToUtc(dateText, '24:00') };
}

async function externalFetch(url: string, init: RequestInit = {}, expect: 'json' | 'text' = 'json'): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 502 || response.status === 503 || response.status === 504;
        if (retryable && attempt < 2) { await wait(200 * (attempt + 1)); continue; }
        throw new ExternalError(response.status, `external response ${response.status}`);
      }
      try { return expect === 'text' ? text : JSON.parse(text); }
      catch { throw new ExternalError(0, 'malformed external response'); }
    } catch (error) {
      lastError = error;
      if (error instanceof ExternalError && error.status !== undefined && ![502, 503, 504].includes(error.status)) throw error;
      if (attempt < 2) { await wait(200 * (attempt + 1)); continue; }
      if (error instanceof ExternalError) throw error;
      throw new ExternalError(undefined, `external request failed: ${String(error)}`);
    } finally { clearTimeout(timer); }
  }
  throw lastError instanceof Error ? lastError : new ExternalError(undefined, 'external request failed');
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function xmlTag(block: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() ?? '';
}

async function fetchStores(vendor: Vendor): Promise<{ externalStoreId: string; name: string }[]> {
  const raw = await externalFetch(`${VENDOR_URLS[vendor]}/stores`, {}, vendor === 'VENDOR_B' ? 'text' : 'json');
  if (vendor === 'VENDOR_A') {
    if (!raw || !Array.isArray(raw.list)) throw new Error('invalid vendor A stores response');
    return raw.list.map((item: any) => ({ externalStoreId: String(item.storeId), name: String(item.storeName) }));
  }
  if (vendor === 'VENDOR_C') {
    if (!raw || !Array.isArray(raw.shopList)) throw new Error('invalid vendor C stores response');
    return raw.shopList.map((item: any) => ({ externalStoreId: String(item.SHOP_ID), name: String(item.SHOP_NAME) }));
  }
  const stores: { externalStoreId: string; name: string }[] = [];
  for (const block of raw.match(/<store>[\s\S]*?<\/store>/gi) ?? []) {
    const externalStoreId = xmlTag(block, 'shopCode');
    if (!externalStoreId) throw new Error('invalid vendor B store row');
    stores.push({ externalStoreId, name: xmlTag(block, 'shopName') });
  }
  return stores;
}

function mapA(item: any): CanonicalLesson {
  if (!item?.bookingId || !item.storeId || !item.memberName || !item.memberPhone || !item.instructorName || !item.instructorPhone || !item.startAt || !item.endAt) throw new Error('invalid vendor A booking');
  const status = item.status === 'RESERVED' || item.status === 'CHECKED_IN' || item.status === 'CANCELED' ? item.status : 'UNKNOWN';
  const startAt = new Date(item.startAt); const endAt = new Date(item.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) throw new Error('invalid vendor A time');
  return { externalBookingId: String(item.bookingId), externalStoreId: String(item.storeId), memberExternalId: item.memberId ? String(item.memberId) : undefined, memberName: String(item.memberName ?? ''), memberPhone: normalizeKoreanPhone(item.memberPhone), instructorExternalId: item.instructorId ? String(item.instructorId) : undefined, instructorName: String(item.instructorName ?? ''), instructorPhone: normalizeKoreanPhone(item.instructorPhone), startAt, endAt, status, rawStatus: String(item.status ?? '') };
}
function mapB(block: string): CanonicalLesson {
  const date = xmlTag(block, 'lessonDate');
  const externalBookingId = xmlTag(block, 'bookingNo');
  const externalStoreId = xmlTag(block, 'shopCode');
  if (!externalBookingId || !externalStoreId || !date || !xmlTag(block, 'beginTime') || !xmlTag(block, 'finishTime')) throw new Error('invalid vendor B booking');
  const startAt = kstToUtc(date, xmlTag(block, 'beginTime')); const endAt = kstToUtc(date, xmlTag(block, 'finishTime'));
  if (endAt <= startAt) throw new Error('invalid vendor B time');
  const cancel = xmlTag(block, 'cancelYn').toUpperCase();
  return { externalBookingId, externalStoreId, memberName: xmlTag(block, 'custName'), memberPhone: normalizeKoreanPhone(xmlTag(block, 'custPhone')), instructorName: xmlTag(block, 'proName'), instructorPhone: normalizeKoreanPhone(xmlTag(block, 'proPhone')), startAt, endAt, status: cancel === 'Y' ? LessonStatus.CANCELED : cancel === 'N' ? LessonStatus.RESERVED : LessonStatus.UNKNOWN, rawStatus: cancel };
}
function mapC(item: any): CanonicalLesson {
  if (!item?.BOOKING_ID || !item.SHOP_ID || !item.USER_NAME || !item.PHONE || !item.DATE || !item.START_TIME || !item.END_TIME || !item.PRO_NAME || !item.PRO_PHONE) throw new Error('invalid vendor C booking');
  const startAt = kstToUtc(String(item.DATE), String(item.START_TIME)); const endAt = kstToUtc(String(item.DATE), String(item.END_TIME));
  if (endAt <= startAt) throw new Error('invalid vendor C time');
  const raw = String(item.STATE ?? '');
  const status = raw === '1' ? LessonStatus.RESERVED : raw === '2' ? LessonStatus.CHECKED_IN : raw === '9' ? LessonStatus.CANCELED : LessonStatus.UNKNOWN;
  return { externalBookingId: String(item.BOOKING_ID), externalStoreId: String(item.SHOP_ID), memberName: String(item.USER_NAME ?? ''), memberPhone: normalizeKoreanPhone(item.PHONE), instructorName: String(item.PRO_NAME ?? ''), instructorPhone: normalizeKoreanPhone(item.PRO_PHONE), startAt, endAt, status, rawStatus: raw };
}
async function fetchLessons(vendor: Vendor, externalStoreId: string, date: string): Promise<CanonicalLesson[]> {
  const all: CanonicalLesson[] = [];
  let page = 1;
  while (true) {
    let raw: any;
    if (vendor === 'VENDOR_A') raw = await externalFetch(`${VENDOR_URLS[vendor]}/bookings?storeId=${encodeURIComponent(externalStoreId)}&date=${date}&page=${page}`);
    else if (vendor === 'VENDOR_B') raw = await externalFetch(`${VENDOR_URLS[vendor]}/bookings?shopCode=${encodeURIComponent(externalStoreId)}&searchDate=${date.replace(/-/g, '')}&page=${page}`, {}, 'text');
    else raw = await externalFetch(`${VENDOR_URLS[vendor]}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ SHOP_ID: externalStoreId, DATE: date, page }) });
    if (vendor === 'VENDOR_A') {
      if (!raw || !Array.isArray(raw.list) || !raw.pageInfo || !Number.isInteger(raw.pageInfo.totalPage) || raw.pageInfo.totalPage < 1) throw new Error('invalid vendor A booking response');
      all.push(...raw.list.map(mapA)); if (page >= raw.pageInfo.totalPage) break;
    } else if (vendor === 'VENDOR_B') {
      if (typeof raw !== 'string' || !/<result[\s>]/i.test(raw) || !/<hasNextPage>/i.test(raw)) throw new Error('invalid vendor B booking response');
      for (const block of raw.match(/<booking>[\s\S]*?<\/booking>/gi) ?? []) all.push(mapB(block));
      const nextValue = xmlTag(raw, 'hasNextPage').toLowerCase(); if (!['true', 'false'].includes(nextValue)) throw new Error('invalid vendor B pagination');
      if (nextValue === 'false') break;
    } else {
      if (!raw || !Array.isArray(raw.bookingList) || !raw.page || !Number.isInteger(raw.page.totalPageCount) || raw.page.totalPageCount < 1) throw new Error('invalid vendor C booking response');
      all.push(...raw.bookingList.map(mapC)); if (page >= raw.page.totalPageCount) break;
    }
    page += 1;
    if (page > 10_000) throw new Error('external pagination exceeded limit');
  }
  // Keep this metadata non-enumerable so callers still receive a normal array.
  Object.defineProperty(all, 'pagesFetched', { value: page, enumerable: false });
  return all;
}

async function upsertIdentity(tx: any, vendor: Vendor, personType: PersonType, externalId: string | undefined, phone: string, name: string): Promise<string | null> {
  if (!phone) return null;
  let user = await tx.user.findUnique({ where: { phoneNormalized: phone } });
  const where = externalId ? { vendor, personType, externalId } : undefined;
  const existing = where ? await tx.externalPersonIdentity.findFirst({ where }) : await tx.externalPersonIdentity.findFirst({ where: { vendor, personType, phoneNormalized: phone } });
  if (existing?.userId) user = await tx.user.findUnique({ where: { id: existing.userId } });
  if (existing) await tx.externalPersonIdentity.update({ where: { id: existing.id }, data: { phoneNormalized: phone, displayName: name, userId: user?.id ?? null } });
  else await tx.externalPersonIdentity.create({ data: { vendor, personType, externalId: externalId ?? null, phoneNormalized: phone, displayName: name, userId: user?.id ?? null } });
  return user?.id ?? null;
}
async function ensureStore(vendor: Vendor, externalStoreId: string, name: string) {
  return prisma.store.upsert({ where: { vendor_externalStoreId: { vendor, externalStoreId } }, update: { name }, create: { vendor, externalStoreId, name } });
}

async function syncTarget(vendor: Vendor, store: { id: string; externalStoreId: string }, lessonDate: string): Promise<{ complete: boolean; lessons: number }> {
  const now = new Date();
  const target = await prisma.syncTarget.upsert({ where: { vendor_storeId_lessonDate: { vendor, storeId: store.id, lessonDate } }, update: {}, create: { vendor, storeId: store.id, lessonDate } });
  const claimed = await prisma.syncTarget.updateMany({ where: { id: target.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseOwner: SYNC_WORKER_ID, leaseUntil: new Date(now.getTime() + 60_000), lastStartedAt: now, lastComplete: false, error: null } });
  if (claimed.count !== 1) return { complete: false, lessons: 0 };
  const run = await prisma.syncRun.create({ data: { targetId: target.id, status: SyncRunStatus.RUNNING } });
  try {
    const lessons = await fetchLessons(vendor, store.externalStoreId, lessonDate);
    const { start, end } = dayBounds(lessonDate);
    const completeAt = new Date();
    let created = 0;
    await prisma.$transaction(async (tx) => {
      for (const item of lessons) {
        const memberUserId = await upsertIdentity(tx, vendor, PersonType.MEMBER, item.memberExternalId, item.memberPhone, item.memberName);
        const instructorUserId = await upsertIdentity(tx, vendor, PersonType.INSTRUCTOR, item.instructorExternalId, item.instructorPhone, item.instructorName);
        const existing = await tx.lesson.findUnique({ where: { vendor_externalBookingId: { vendor, externalBookingId: item.externalBookingId } } });
        const data: any = {
          storeId: store.id, memberNameSnapshot: item.memberName, memberPhoneSnapshot: item.memberPhone,
          instructorNameSnapshot: item.instructorName, instructorPhoneSnapshot: item.instructorPhone,
          startAt: item.startAt, endAt: item.endAt, status: item.status, rawStatus: item.rawStatus,
          lastSyncedAt: completeAt, lastCompleteTargetAt: completeAt, sourceMissingAt: null,
          sourceCancelReason: item.status === LessonStatus.CANCELED ? item.rawStatus : null,
        };
        if (memberUserId) data.memberUserId = memberUserId;
        if (instructorUserId) data.instructorUserId = instructorUserId;
        await tx.lesson.upsert({ where: { vendor_externalBookingId: { vendor, externalBookingId: item.externalBookingId } }, update: data, create: { vendor, externalBookingId: item.externalBookingId, ...data } });
        if (!existing) created += 1;
      }
      const seenIds = lessons.map((item) => item.externalBookingId);
      if (seenIds.length > 0) {
        await tx.lesson.updateMany({ where: { vendor, storeId: store.id, startAt: { gte: start, lt: end }, externalBookingId: { notIn: seenIds }, status: { not: LessonStatus.SOURCE_MISSING } }, data: { status: LessonStatus.SOURCE_MISSING, sourceMissingAt: completeAt, rawStatus: 'SOURCE_MISSING', lastSyncedAt: completeAt } });
      } else {
        await tx.lesson.updateMany({ where: { vendor, storeId: store.id, startAt: { gte: start, lt: end }, status: { not: LessonStatus.SOURCE_MISSING } }, data: { status: LessonStatus.SOURCE_MISSING, sourceMissingAt: completeAt, rawStatus: 'SOURCE_MISSING', lastSyncedAt: completeAt } });
      }
      await tx.feedbackRequest.updateMany({ where: { status: { in: [FeedbackRequestStatus.PENDING, FeedbackRequestStatus.RETRY_WAIT, FeedbackRequestStatus.SENDING] }, lesson: { vendor, storeId: store.id, startAt: { gte: start, lt: end }, status: LessonStatus.SOURCE_MISSING } }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: 'SOURCE_MISSING', leaseOwner: null, leaseUntil: null } });
      const pagesFetched = Number((lessons as any).pagesFetched ?? 1);
      await tx.syncTarget.update({ where: { id: target.id }, data: { leaseOwner: null, leaseUntil: null, lastCompletedAt: completeAt, lastComplete: true, pagesFetched, retryCount: 0, error: null } });
      await tx.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.COMPLETED, pagesFetched, lessonsSeen: lessons.length, lessonsCreated: created, lessonsUpdated: lessons.length - created, complete: true, completedAt: completeAt } });
    });
    await ensureFeedbackRequests(store.id, lessonDate);
    return { complete: true, lessons: lessons.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncTarget.update({ where: { id: target.id }, data: { leaseOwner: null, leaseUntil: null, lastComplete: false, error: message, retryCount: { increment: 1 } } }).catch(() => undefined);
    await prisma.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.FAILED, failureReason: message, complete: false, completedAt: new Date() } }).catch(() => undefined);
    return { complete: false, lessons: 0 };
  }
}

async function syncAll(date = kstDate()): Promise<any> {
  const result: any[] = [];
  for (const vendor of [Vendor.VENDOR_A, Vendor.VENDOR_B, Vendor.VENDOR_C]) {
    try {
      const stores = await fetchStores(vendor);
      for (const item of stores) {
        const store = await ensureStore(vendor, item.externalStoreId, item.name);
        result.push({ vendor, storeId: store.id, externalStoreId: item.externalStoreId, ...(await syncTarget(vendor, store, date)) });
      }
    } catch (error) { result.push({ vendor, complete: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}
async function syncOwnedStores(memberships: Array<{ storeId: string; store: { id: string; vendor: Vendor; externalStoreId: string } }>, date: string): Promise<any[]> {
  const result: any[] = [];
  for (const item of memberships) {
    result.push({ vendor: item.store.vendor, storeId: item.storeId, externalStoreId: item.store.externalStoreId, ...(await syncTarget(item.store.vendor, item.store, date)) });
  }
  return result;
}
function nextKstDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
async function syncDateWindow(date = kstDate()): Promise<any[]> {
  return [...await syncAll(date), ...await syncAll(nextKstDate(date))];
}

async function ensureFeedbackRequests(storeId: string, lessonDate?: string): Promise<number> {
  const where: any = { storeId, endAt: { lt: new Date() }, status: { in: [LessonStatus.RESERVED, LessonStatus.CHECKED_IN] }, lastCompleteTargetAt: { not: null }, feedback: null };
  if (lessonDate) { const bounds = dayBounds(lessonDate); where.startAt = { gte: bounds.start, lt: bounds.end }; }
  const lessons = await prisma.lesson.findMany({ where });
  let count = 0;
  for (const lesson of lessons) {
    if (!lesson.lastCompleteTargetAt || lesson.lastCompleteTargetAt < lesson.endAt || !lesson.instructorPhoneSnapshot) continue;
    await prisma.feedbackRequest.upsert({ where: { lessonId: lesson.id }, update: {}, create: { lessonId: lesson.id, referenceKey: `FEEDBACK_REQUEST:${lesson.id}`, recipientPhone: lesson.instructorPhoneSnapshot, message: `레슨(${lesson.memberNameSnapshot}) 피드백을 작성해 주세요.`, status: FeedbackRequestStatus.PENDING } });
    count += 1;
  }
  return count;
}

async function sendMessage(request: any): Promise<void> {
  const now = new Date();
  if (![FeedbackRequestStatus.PENDING, FeedbackRequestStatus.RETRY_WAIT].includes(request.status)) return;
  if (request.nextAttemptAt && request.nextAttemptAt > now) return;
  const claim = await prisma.feedbackRequest.updateMany({ where: { id: request.id, status: request.status, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { status: FeedbackRequestStatus.SENDING, leaseOwner: SYNC_WORKER_ID, leaseUntil: new Date(now.getTime() + 60_000) } });
  if (claim.count !== 1) return;
  const fresh = await prisma.feedbackRequest.findUnique({ where: { id: request.id }, include: { lesson: { include: { feedback: true } } } });
  if (!fresh || fresh.lesson.feedback || [LessonStatus.CANCELED, LessonStatus.UNKNOWN, LessonStatus.SOURCE_MISSING].includes(fresh.lesson.status as any) || fresh.lesson.endAt >= new Date() || !fresh.lesson.lastCompleteTargetAt || fresh.lesson.lastCompleteTargetAt < fresh.lesson.endAt) {
    await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: fresh?.lesson.feedback ? 'FEEDBACK_EXISTS' : 'LESSON_NOT_ELIGIBLE', leaseOwner: null, leaseUntil: null } });
    return;
  }
  const count = await prisma.messageAttempt.count({ where: { feedbackRequestId: request.id } });
  const attemptNo = count + 1;
  const attempt = await prisma.messageAttempt.create({ data: { feedbackRequestId: request.id, attemptNo, status: MessageAttemptStatus.SENDING, submittedAt: now } });
  try {
    const response = await fetch(`${MESSAGING_URL}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientPhone: request.recipientPhone, message: request.message, referenceKey: request.referenceKey }), signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    if (response.status === 502) {
      const terminal = attemptNo >= 3;
      await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.FAILED, reason: 'PROVIDER_502', resolvedAt: new Date() } });
      await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: terminal ? FeedbackRequestStatus.EXHAUSTED : FeedbackRequestStatus.RETRY_WAIT, nextAttemptAt: terminal ? null : new Date(Date.now() + 30_000), leaseOwner: null, leaseUntil: null, reason: terminal ? 'MAX_ATTEMPTS' : 'PROVIDER_502' } });
      return;
    }
    if (response.status !== 202) throw new ExternalError(response.status, `message provider response ${response.status}`);
    let accepted: any; try { accepted = JSON.parse(text); } catch { throw new ExternalError(undefined, 'malformed message provider response', true); }
    if (!accepted?.messageId) throw new ExternalError(undefined, 'message provider response missing messageId', true);
    await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.ACCEPTED, providerMessageId: String(accepted.messageId), resolvedAt: null, nextPollAt: new Date(Date.now() + 10_000) } });
    await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: FeedbackRequestStatus.ACCEPTED, leaseOwner: null, leaseUntil: null, reason: null } });
  } catch (error) {
    const ambiguous = error instanceof ExternalError ? error.ambiguous || error.status === undefined : true;
    await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: ambiguous ? MessageAttemptStatus.UNKNOWN : MessageAttemptStatus.CLOSED, reason: error instanceof Error ? error.message : String(error), resolvedAt: new Date() } });
    await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: ambiguous ? FeedbackRequestStatus.RECONCILE_REQUIRED : FeedbackRequestStatus.RECONCILE_REQUIRED, leaseOwner: null, leaseUntil: null, reason: ambiguous ? 'AMBIGUOUS_SUBMIT' : String(error) } });
  }
}
async function pollAcceptedAttempts(storeIds?: string[]): Promise<number> {
  const attempts = await prisma.messageAttempt.findMany({ where: { ...(storeIds ? { feedbackRequest: { lesson: { storeId: { in: storeIds } } } } : {}), status: MessageAttemptStatus.ACCEPTED, providerMessageId: { not: null }, OR: [{ nextPollAt: null }, { nextPollAt: { lte: new Date() } }] }, include: { feedbackRequest: { include: { lesson: { include: { feedback: true } } } } } });
  let polled = 0;
  for (const attempt of attempts) {
    polled += 1;
    if (attempt.feedbackRequest.lesson.feedback) {
      await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.CLOSED, reason: 'FEEDBACK_EXISTS', resolvedAt: new Date() } });
      await prisma.feedbackRequest.update({ where: { id: attempt.feedbackRequestId }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: 'FEEDBACK_EXISTS' } });
      continue;
    }
    try {
      const raw = await externalFetch(`${MESSAGING_URL}/messages/${encodeURIComponent(attempt.providerMessageId!)}`);
      if (!raw || !['ACCEPTED', 'DELIVERED', 'FAILED'].includes(String(raw.status))) throw new ExternalError(0, 'malformed message status');
      if (raw.status === 'DELIVERED') {
        await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.DELIVERED, resolvedAt: new Date(), nextPollAt: null } });
        await prisma.feedbackRequest.update({ where: { id: attempt.feedbackRequestId }, data: { status: FeedbackRequestStatus.DELIVERED, leaseOwner: null, leaseUntil: null, reason: null } });
      } else if (raw.status === 'FAILED') {
        const totalAttempts = await prisma.messageAttempt.count({ where: { feedbackRequestId: attempt.feedbackRequestId } });
        const terminal = totalAttempts >= 3;
        await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.FAILED, reason: String(raw.failureReason ?? 'PROVIDER_FAILED'), resolvedAt: new Date(), nextPollAt: null } });
        await prisma.feedbackRequest.update({ where: { id: attempt.feedbackRequestId }, data: { status: terminal ? FeedbackRequestStatus.EXHAUSTED : FeedbackRequestStatus.RETRY_WAIT, nextAttemptAt: terminal ? null : new Date(Date.now() + 30_000), reason: terminal ? 'MAX_ATTEMPTS' : 'PROVIDER_FAILED' } });
      } else {
        await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { nextPollAt: new Date(Date.now() + 10_000) } });
      }
    } catch (error) {
      const age = Date.now() - attempt.createdAt.getTime();
      const status = error instanceof ExternalError ? error.status : undefined;
      if (status === 404 || status === 400 || age >= 10 * 60_000 || (error instanceof ExternalError && error.status === 0)) {
        await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { status: MessageAttemptStatus.CLOSED, reason: status === 404 ? 'PROVIDER_MESSAGE_NOT_FOUND' : 'POLL_RECONCILIATION_REQUIRED', resolvedAt: new Date(), nextPollAt: null } });
        await prisma.feedbackRequest.update({ where: { id: attempt.feedbackRequestId }, data: { status: FeedbackRequestStatus.RECONCILE_REQUIRED, reason: status === 404 ? 'PROVIDER_MESSAGE_NOT_FOUND' : 'POLL_RECONCILIATION_REQUIRED' } });
      } else {
        await prisma.messageAttempt.update({ where: { id: attempt.id }, data: { nextPollAt: new Date(Date.now() + 10_000) } });
      }
    }
  }
  return polled;
}
async function processMessaging(storeIds?: string[]): Promise<number> {
  await pollAcceptedAttempts(storeIds);
  const requests = await prisma.feedbackRequest.findMany({ where: { ...(storeIds ? { lesson: { storeId: { in: storeIds } } } : {}), status: { in: [FeedbackRequestStatus.PENDING, FeedbackRequestStatus.RETRY_WAIT] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] }, include: { lesson: { include: { feedback: true } } } });
  let processed = 0;
  for (const request of requests) {
    if (request.lesson.feedback) { await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: 'FEEDBACK_EXISTS' } }); continue; }
    if (([LessonStatus.CANCELED, LessonStatus.UNKNOWN, LessonStatus.SOURCE_MISSING] as string[]).includes(request.lesson.status) || request.lesson.endAt >= new Date() || !request.lesson.lastCompleteTargetAt || request.lesson.lastCompleteTargetAt < request.lesson.endAt) { await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: 'LESSON_NOT_ELIGIBLE' } }); continue; }
    await sendMessage(request); processed += 1;
  }
  return processed;
}
async function reconcileMessageRequest(requestId: string): Promise<{ status: string; matches: number }> {
  const request = await prisma.feedbackRequest.findUnique({ where: { id: requestId }, include: { attempts: true } });
  if (!request) throw new Error('feedback request not found');
  if (request.status !== FeedbackRequestStatus.RECONCILE_REQUIRED) return { status: request.status, matches: 0 };
  const matches: any[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const raw = await externalFetch(`${MESSAGING_URL}/messages?page=${page}`);
    if (!raw || !Array.isArray(raw.list) || !raw.pageInfo) throw new ExternalError(0, 'malformed message history');
    matches.push(...raw.list.filter((item: any) => item.referenceKey === request.referenceKey && normalizeKoreanPhone(String(item.recipientPhone ?? '')) === request.recipientPhone && String(item.message ?? '') === request.message));
    if (page >= Number(raw.pageInfo.totalPage ?? 1)) break;
  }
  if (matches.length !== 1) return { status: request.status, matches: matches.length };
  const found = matches[0];
  const previous = request.attempts.sort((a: any, b: any) => b.attemptNo - a.attemptNo)[0];
  if (previous) await prisma.messageAttempt.update({ where: { id: previous.id }, data: { status: found.status === 'DELIVERED' ? MessageAttemptStatus.DELIVERED : MessageAttemptStatus.ACCEPTED, providerMessageId: String(found.messageId), resolvedAt: found.resolvedAt ? new Date(found.resolvedAt) : null, reason: null } });
  await prisma.feedbackRequest.update({ where: { id: request.id }, data: { status: found.status === 'DELIVERED' ? FeedbackRequestStatus.DELIVERED : FeedbackRequestStatus.ACCEPTED, reason: null } });
  return { status: found.status, matches: 1 };
}

async function resolveStore(storeId: string): Promise<any | null> {
  return prisma.store.findFirst({ where: { OR: [{ id: storeId }, { externalStoreId: storeId }] } });
}
async function membership(userId: string, storeId: string): Promise<any | null> { return prisma.membership.findUnique({ where: { userId_storeId: { userId, storeId } } }); }
function canReadLesson(userId: string, role: MembershipRole, lesson: any): boolean {
  return role === MembershipRole.OWNER || (role === MembershipRole.INSTRUCTOR && lesson.instructorUserId === userId) || (role === MembershipRole.MEMBER && lesson.memberUserId === userId);
}
function serializeUser(user: any) { return { id: user.id, name: user.name, phone: user.phoneNormalized }; }
function serializeStore(store: any) { return { id: store.id, vendor: store.vendor, externalStoreId: store.externalStoreId, name: store.name }; }
function serializeLesson(lesson: any) {
  return { id: lesson.id, storeId: lesson.storeId, vendor: lesson.vendor, externalBookingId: lesson.externalBookingId, member: { id: lesson.memberUserId, name: lesson.memberNameSnapshot, phone: lesson.memberPhoneSnapshot }, instructor: { id: lesson.instructorUserId, name: lesson.instructorNameSnapshot, phone: lesson.instructorPhoneSnapshot }, startAt: lesson.startAt.toISOString(), endAt: lesson.endAt.toISOString(), status: lesson.status, rawStatus: lesson.rawStatus, feedback: lesson.feedback ? { id: lesson.feedback.id, content: lesson.feedback.content, authorUserId: lesson.feedback.authorUserId, createdAt: lesson.feedback.createdAt.toISOString(), updatedAt: lesson.feedback.updatedAt.toISOString() } : null };
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = parsed.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (isMutation(req) && !checkOrigin(req)) { sendError(res, 403, 'origin is not allowed'); return; }
  const auth = await authenticate(req).catch(() => null);
  if (isMutation(req) && auth && !checkCsrf(req)) { sendError(res, 403, 'csrf token required'); return; }

  if (req.method === 'GET' && path === '/health') {
    try { await prisma.$queryRaw`SELECT 1`; send(res, 200, { status: 'ok', database: 'ok' }); } catch { send(res, 503, { status: 'degraded', database: 'unavailable' }); }
    return;
  }
  if (req.method === 'POST' && path === '/auth/register') {
    try {
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) { sendError(res, 400, 'request body must be an object'); return; }
      const name = String(input.name ?? '').trim(); const phone = normalizeKoreanPhone(String(input.phone ?? '')); const password = String(input.password ?? '');
      if (!name || !isValidPhone(phone) || password.length < 8) { sendError(res, 400, 'name, valid phone and password (8+ characters) are required'); return; }
      if (input.storeId !== undefined) { sendError(res, 400, 'store membership is granted by the organization'); return; }
      const exists = await prisma.user.findUnique({ where: { phoneNormalized: phone } }); if (exists) { sendError(res, 409, 'phone is already registered'); return; }
      const user = await prisma.user.create({ data: { name, phoneNormalized: phone, passwordHash: await hashPassword(password) } });
      const session = await createSession(user); const csrf = randomBytes(24).toString('base64url');
      send(res, 201, { user: serializeUser(user) }, { 'Set-Cookie': [cookieHeader(COOKIE_NAME, session, Math.floor(SESSION_TTL_MS / 1000), true), cookieHeader(CSRF_COOKIE_NAME, csrf, Math.floor(SESSION_TTL_MS / 1000), false)] });
    } catch (error) { sendError(res, error instanceof ExternalError ? error.status ?? 400 : 500, error instanceof Error ? error.message : 'registration failed'); }
    return;
  }
  if (req.method === 'POST' && path === '/auth/login') {
    try {
      const input = await body(req); if (!input || typeof input !== 'object' || Array.isArray(input)) { sendError(res, 400, 'request body must be an object'); return; }
      const phone = normalizeKoreanPhone(String(input.phone ?? '')); const user = await prisma.user.findUnique({ where: { phoneNormalized: phone } });
      if (!user || !(await verifyPassword(String(input.password ?? ''), user.passwordHash))) { sendError(res, 401, 'invalid credentials'); return; }
      const session = await createSession(user); const csrf = randomBytes(24).toString('base64url');
      send(res, 200, { user: serializeUser(user) }, { 'Set-Cookie': [cookieHeader(COOKIE_NAME, session, Math.floor(SESSION_TTL_MS / 1000), true), cookieHeader(CSRF_COOKIE_NAME, csrf, Math.floor(SESSION_TTL_MS / 1000), false)] });
    } catch (error) { sendError(res, error instanceof ExternalError ? error.status ?? 400 : 500, error instanceof Error ? error.message : 'login failed'); }
    return;
  }
  if (req.method === 'POST' && path === '/auth/logout') {
    if (auth) await prisma.session.delete({ where: { id: auth.sessionId } }).catch(() => undefined);
    send(res, 200, { ok: true }, { 'Set-Cookie': [clearCookieHeader(COOKIE_NAME, true), clearCookieHeader(CSRF_COOKIE_NAME, false)] }); return;
  }
  if (req.method === 'GET' && path === '/auth/me') {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const memberships = await prisma.membership.findMany({ where: { userId: auth.user.id }, include: { store: true } });
    send(res, 200, { user: auth.user, memberships: memberships.map((item) => ({ role: item.effectiveRole, store: serializeStore(item.store) })) }); return;
  }
  if (req.method === 'GET' && path === '/stores') {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const memberships = await prisma.membership.findMany({ where: { userId: auth.user.id }, include: { store: true } });
    send(res, 200, { stores: memberships.map((item) => ({ ...serializeStore(item.store), role: item.effectiveRole })) }); return;
  }
  if (req.method === 'POST' && path === '/sync') {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const input = await body(req); if (!input || typeof input !== 'object' || Array.isArray(input)) { sendError(res, 400, 'request body must be an object'); return; }
    const memberships = await prisma.membership.findMany({ where: { userId: auth.user.id, effectiveRole: MembershipRole.OWNER }, include: { store: true } });
    if (!memberships.length) { sendError(res, 403, 'owner role required'); return; }
    const date = String(input.date ?? parsed.searchParams.get('date') ?? kstDate());
    if (!isValidDateText(date)) { sendError(res, 400, 'date must be a valid YYYY-MM-DD calendar date'); return; }
    const result = await syncOwnedStores(memberships, date); await processMessaging(memberships.map((item) => item.storeId)); send(res, 200, { date, result }); return;
  }
  if (req.method === 'POST' && path === '/feedback-requests/process') {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const owner = await prisma.membership.findFirst({ where: { userId: auth.user.id, effectiveRole: MembershipRole.OWNER } });
    if (!owner) { sendError(res, 403, 'owner role required'); return; }
    const ownerStores = await prisma.membership.findMany({ where: { userId: auth.user.id, effectiveRole: MembershipRole.OWNER }, select: { storeId: true } });
    send(res, 200, { processed: await processMessaging(ownerStores.map((item) => item.storeId)) }); return;
  }
  const reconcilePath = /^\/feedback-requests\/([^/]+)\/reconcile$/.exec(path);
  if (req.method === 'POST' && reconcilePath) {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const request = await prisma.feedbackRequest.findUnique({ where: { id: decodeURIComponent(reconcilePath[1]) }, include: { lesson: true } });
    if (!request) { sendError(res, 404, 'feedback request not found'); return; }
    const owner = await membership(auth.user.id, request.lesson.storeId);
    if (!owner || owner.effectiveRole !== MembershipRole.OWNER) { sendError(res, 403, 'store owner role required'); return; }
    try { send(res, 200, await reconcileMessageRequest(decodeURIComponent(reconcilePath[1]))); }
    catch (error) { sendError(res, error instanceof ExternalError ? 502 : 400, error instanceof Error ? error.message : 'reconciliation failed'); }
    return;
  }
  const feedbackRequestPath = /^\/lessons\/([^/]+)\/feedback-request$/.exec(path);
  if (req.method === 'POST' && feedbackRequestPath) {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const lessonId = decodeURIComponent(feedbackRequestPath[1]);
    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, include: { feedback: true } });
    if (!lesson) { sendError(res, 404, 'lesson not found'); return; }
    const member = await membership(auth.user.id, lesson.storeId);
    if (!member || !canReadLesson(auth.user.id, member.effectiveRole, lesson)) { sendError(res, 403, 'lesson access denied'); return; }
    const canRequest = member.effectiveRole === MembershipRole.OWNER || (member.effectiveRole === MembershipRole.INSTRUCTOR && lesson.instructorUserId === auth.user.id);
    if (!canRequest) { sendError(res, 403, 'only assigned instructor or owner may request feedback'); return; }
    if (lesson.feedback || lesson.endAt >= new Date() || (lesson.status !== LessonStatus.RESERVED && lesson.status !== LessonStatus.CHECKED_IN) || !lesson.lastCompleteTargetAt || lesson.lastCompleteTargetAt < lesson.endAt) {
      sendError(res, 409, 'lesson is not eligible for a feedback request'); return;
    }
    const request = await prisma.feedbackRequest.upsert({
      where: { lessonId: lesson.id },
      update: {},
      create: { lessonId: lesson.id, referenceKey: `FEEDBACK_REQUEST:${lesson.id}`, recipientPhone: lesson.instructorPhoneSnapshot, message: `레슨(${lesson.memberNameSnapshot}) 피드백을 작성해 주세요.`, status: FeedbackRequestStatus.PENDING },
    });
    await processMessaging();
    send(res, 202, { request });
    return;
  }
  const storeLessons = /^\/stores\/([^/]+)\/lessons$/.exec(path);
  if (req.method === 'GET' && storeLessons) {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    const store = await resolveStore(decodeURIComponent(storeLessons[1])); if (!store) { sendError(res, 404, 'store not found'); return; }
    const member = await membership(auth.user.id, store.id); if (!member) { sendError(res, 403, 'store membership required'); return; }
    const where: any = { storeId: store.id }; const date = parsed.searchParams.get('date'); if (date) { if (!isValidDateText(date)) { sendError(res, 400, 'date must be a valid YYYY-MM-DD calendar date'); return; } const bounds = dayBounds(date); where.startAt = { gte: bounds.start, lt: bounds.end }; }
    const status = parsed.searchParams.get('status'); if (status) { if (!Object.values(LessonStatus).includes(status as LessonStatus)) { sendError(res, 400, 'invalid lesson status'); return; } where.status = status as LessonStatus; }
    const lessons = await prisma.lesson.findMany({ where, include: { feedback: true }, orderBy: { startAt: 'asc' } });
    send(res, 200, { store: serializeStore(store), lessons: lessons.filter((lesson) => canReadLesson(auth.user.id, member.effectiveRole, lesson)).map(serializeLesson) }); return;
  }
  const lessonPath = /^\/lessons\/([^/]+)$/.exec(path); const feedbackPath = /^\/lessons\/([^/]+)\/feedback$/.exec(path);
  if ((req.method === 'GET' || req.method === 'POST' || req.method === 'PATCH') && (lessonPath || feedbackPath)) {
    if (!auth) { sendError(res, 401, 'authentication required'); return; }
    if (lessonPath && req.method !== 'GET') { sendError(res, 404, 'not found'); return; }
    const lessonId = decodeURIComponent((lessonPath ?? feedbackPath)![1]);
    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, include: { feedback: true, store: true } }) ?? await prisma.lesson.findFirst({ where: { externalBookingId: lessonId }, include: { feedback: true, store: true } });
    if (!lesson) { sendError(res, 404, 'lesson not found'); return; }
    const member = await membership(auth.user.id, lesson.storeId); if (!member || !canReadLesson(auth.user.id, member.effectiveRole, lesson)) { sendError(res, 403, 'lesson access denied'); return; }
    if (lessonPath && req.method === 'GET') { send(res, 200, { lesson: serializeLesson(lesson) }); return; }
    if (feedbackPath && req.method === 'GET') { send(res, 200, { feedback: lesson.feedback ? serializeLesson(lesson).feedback : null }); return; }
    if (member.effectiveRole !== MembershipRole.OWNER && !(member.effectiveRole === MembershipRole.INSTRUCTOR && lesson.instructorUserId === auth.user.id)) { sendError(res, 403, 'only assigned instructor or owner may write feedback'); return; }
    if (lesson.endAt >= new Date()) { sendError(res, 409, 'feedback is available after lesson end'); return; }
    if (([LessonStatus.CANCELED, LessonStatus.UNKNOWN, LessonStatus.SOURCE_MISSING] as string[]).includes(lesson.status)) { sendError(res, 409, 'lesson status does not allow feedback'); return; }
    if (!lesson.lastCompleteTargetAt || lesson.lastCompleteTargetAt < lesson.endAt) { sendError(res, 409, 'lesson data is not freshly synchronized'); return; }
    const input = await body(req); const content = String(input.content ?? '').trim(); if (!content || content.length > 10_000) { sendError(res, 400, 'content is required and must be at most 10000 characters'); return; }
    try {
      const feedback = req.method === 'POST'
        ? await prisma.feedback.create({ data: { lessonId: lesson.id, authorUserId: auth.user.id, content } })
        : lesson.feedback ? await prisma.feedback.update({ where: { id: lesson.feedback.id }, data: { content } }) : await prisma.feedback.create({ data: { lessonId: lesson.id, authorUserId: auth.user.id, content } });
      await prisma.feedbackRequest.updateMany({ where: { lessonId: lesson.id, status: { in: [FeedbackRequestStatus.PENDING, FeedbackRequestStatus.RETRY_WAIT, FeedbackRequestStatus.SENDING] } }, data: { status: FeedbackRequestStatus.SUPPRESSED, reason: 'FEEDBACK_EXISTS', leaseOwner: null, leaseUntil: null } });
      send(res, req.method === 'POST' ? 201 : 200, { feedback });
    } catch (error) { sendError(res, 409, error instanceof Error ? error.message : 'feedback already exists'); }
    return;
  }
  sendError(res, 404, 'not found');
}

const server = createServer((req, res) => {
  applyCors(req, res);
  route(req, res).catch((error) => { console.error('[api]', error); if (!res.headersSent) sendError(res, error instanceof ExternalError ? error.status ?? 400 : 500, error instanceof ExternalError ? error.message : 'internal server error'); });
});
const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`[api] listening on :${PORT}`);
    void syncDateWindow(kstDate()).catch((error) => console.error('[api] initial sync failed', error));
  });
  const interval = setInterval(() => { void syncDateWindow(kstDate()).then(() => processMessaging()).catch((error) => console.error('[api] sync failed', error)); }, Number(process.env.SYNC_INTERVAL_MS ?? 300_000));
  interval.unref();
  process.on('SIGINT', () => { clearInterval(interval); void prisma.$disconnect().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { clearInterval(interval); void prisma.$disconnect().finally(() => process.exit(0)); });
}

export { prisma, syncAll, syncDateWindow, fetchLessons, fetchStores, kstToUtc };
