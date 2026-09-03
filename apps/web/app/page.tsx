"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type View = "lessons" | "detail";
type AuthMode = "login" | "register";
type Role = string;

type JsonRecord = Record<string, unknown>;

interface Membership {
  storeId: string;
  storeName: string;
  role: Role;
}

interface Session {
  subject: string;
  user: JsonRecord;
  memberships: Membership[];
}

interface Lesson extends JsonRecord {
  id: string;
  storeId?: string;
  status?: string;
  startAt?: string;
  endAt?: string;
  member?: JsonRecord | null;
  instructor?: JsonRecord | null;
  store?: JsonRecord | null;
}

interface Feedback extends JsonRecord {
  id?: string;
  content?: string;
  status?: string;
  author?: JsonRecord | null;
  createdAt?: string;
  updatedAt?: string;
}

class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001").replace(/\/$/, "");

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.method && ["POST", "PATCH", "PUT", "DELETE"].includes(init.method.toUpperCase())) {
    const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("lessontalk_csrf="))?.split("=").slice(1).join("=");
    if (csrf) headers.set("X-CSRF-Token", decodeURIComponent(csrf));
  }
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as JsonRecord).error)
      : response.statusText || `Request failed (${response.status})`;
    throw new ApiError(response.status, message, payload);
  }
  return payload as T;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? value as JsonRecord : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function normalizeRole(value: unknown): Role {
  return firstString(value, "MEMBER")!.toUpperCase();
}

function roleLabel(value: unknown): string {
  const role = normalizeRole(value);
  return ({ OWNER: "점주", INSTRUCTOR: "프로", MEMBER: "회원" } as Record<string, string>)[role] || role;
}

function localizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  const translations: Array<[string, string]> = [
    ["authentication required", "로그인이 필요합니다."],
    ["invalid credentials", "전화번호 또는 비밀번호가 올바르지 않습니다."],
    ["store membership required", "해당 매장에 소속되어 있지 않습니다."],
    ["owner role required", "점주 권한이 필요합니다."],
    ["request body must be an object", "요청 형식이 올바르지 않습니다."],
    ["date must be a valid YYYY-MM-DD calendar date", "유효한 날짜를 입력해주세요."],
    ["lesson is not eligible for a feedback request", "현재 피드백 요청을 보낼 수 없는 레슨입니다."],
    ["feedback already exists or was changed concurrently", "피드백이 이미 작성되었거나 동시에 변경되었습니다."],
  ];
  return translations.find(([source]) => message.includes(source))?.[1] || message;
}

function normalizeMemberships(raw: unknown): Membership[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    const store = asRecord(record.store);
    const storeId = firstString(record.storeId, record.shopId, record.id, store.id, store.storeId);
    if (!storeId) return [];
    return [{
      storeId,
      storeName: firstString(record.storeName, record.name, store.name, store.storeName) || storeId,
      role: normalizeRole(record.effectiveRole || record.role || record.membershipRole),
    }];
  });
}

function parseSession(payload: unknown): Session | null {
  const outer = asRecord(payload);
  const user = asRecord(outer.user || payload);
  const subject = firstString(user.id, user.userId, user.subject, outer.subject, outer.userId, user.phone);
  if (!subject) return null;
  const memberships = normalizeMemberships(
    outer.memberships || outer.stores || user.memberships || user.stores,
  );
  return { subject, user, memberships };
}

function extractLessons(payload: unknown): Lesson[] {
  const record = asRecord(payload);
  const list = Array.isArray(payload) ? payload : (record.lessons || record.data || record.items);
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const lesson = asRecord(item);
    const id = firstString(lesson.id, lesson.lessonId, lesson.bookingId);
    return id ? [{ ...lesson, id } as Lesson] : [];
  });
}

function extractFeedback(payload: unknown): Feedback | null {
  if (payload === null || payload === undefined) return null;
  const record = asRecord(payload);
  const value = "feedback" in record ? record.feedback : payload;
  if (value === null || typeof value !== "object") return null;
  return value as Feedback;
}

function displayName(record: JsonRecord | null | undefined, fallback = "—") {
  if (!record) return fallback;
  return firstString(record.name, record.fullName, record.displayName, record.phone, record.id) || fallback;
}

function formatDate(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusTone(status: unknown): "success" | "warning" | "danger" | undefined {
  const value = String(status || "").toUpperCase();
  if (["COMPLETED", "CHECKED_IN", "DELIVERED", "PUBLISHED", "ACTIVE"].includes(value)) return "success";
  if (["CANCELED", "CANCELLED", "UNKNOWN", "SOURCE_MISSING", "FORBIDDEN", "FAILED"].includes(value)) return "danger";
  if (["RESERVED", "PENDING", "ACCEPTED", "RECONCILE_REQUIRED", "RETRY_WAIT"].includes(value)) return "warning";
  return undefined;
}

function StatusPill({ value, fallback = "확인 불가" }: { value?: unknown; fallback?: string }) {
  const labels: Record<string, string> = { RESERVED: "예약", CHECKED_IN: "체크인", CANCELED: "취소", UNKNOWN: "알 수 없음", SOURCE_MISSING: "원본 누락", DELIVERED: "전달 완료", ACCEPTED: "접수", PENDING: "대기", WRITTEN: "작성 완료" };
  const raw = String(value || fallback).toUpperCase();
  const text = labels[raw] || String(value || fallback).replaceAll("_", " ");
  return <span className={`status-pill${statusTone(value) ? ` ${statusTone(value)}` : ""}`}>{text}</span>;
}

function initialRoute() {
  if (typeof window === "undefined") return { view: "lessons" as View, storeId: "", lessonId: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    view: params.get("view") === "detail" ? "detail" as View : "lessons" as View,
    storeId: params.get("store") || "",
    lessonId: params.get("lesson") || "",
  };
}

export default function HomePage() {
  const initial = useMemo(initialRoute, []);
  const cacheRef = useRef(new Map<string, unknown>());
  const activeScopeRef = useRef("");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [session, setSession] = useState<Session | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [activeStoreId, setActiveStoreId] = useState(initial.storeId);
  const [view, setView] = useState<View>(initial.view);
  const [selectedLessonId, setSelectedLessonId] = useState(initial.lessonId);
  const [booting, setBooting] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonsLoading, setLessonsLoading] = useState(false);
  const [lessonsError, setLessonsError] = useState("");
  const [feedbackByLesson, setFeedbackByLesson] = useState<Record<string, Feedback | null>>({});
  const [statusFilter, setStatusFilter] = useState("");
  const [detailLesson, setDetailLesson] = useState<Lesson | null>(null);
  const [detailFeedback, setDetailFeedback] = useState<Feedback | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [feedbackContent, setFeedbackContent] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestMessage, setRequestMessage] = useState("");

  const clearSessionCache = useCallback(() => {
    cacheRef.current.clear();
    setFeedbackByLesson({});
    setLessons([]);
    setDetailLesson(null);
    setDetailFeedback(null);
  }, []);

  const updateRoute = useCallback((next: { view?: View; storeId?: string; lessonId?: string }, replace = false) => {
    const nextView = next.view ?? view;
    const nextStore = next.storeId ?? activeStoreId;
    const nextLesson = next.lessonId ?? (nextView === "detail" ? selectedLessonId : "");
    const params = new URLSearchParams();
    params.set("view", nextView);
    if (nextStore) params.set("store", nextStore);
    if (nextView === "detail" && nextLesson) params.set("lesson", nextLesson);
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
    setView(nextView);
    setActiveStoreId(nextStore);
    setSelectedLessonId(nextLesson);
  }, [activeStoreId, selectedLessonId, view]);

  const expireSession = useCallback(() => {
    clearSessionCache();
    setSession(null);
    setSessionGeneration((value) => value + 1);
    setAuthError("Your session has expired. Please sign in again.");
    setView("lessons");
    setSelectedLessonId("");
    updateRoute({ view: "lessons", storeId: "", lessonId: "" }, true);
  }, [clearSessionCache, updateRoute]);

  const establishSession = useCallback((payload: unknown, preferredStore?: string, preferredView: View = "lessons", preferredLessonId = "") => {
    const nextSession = parseSession(payload);
    if (!nextSession) throw new Error("세션 정보를 불러오지 못했습니다.");
    clearSessionCache();
    setSessionGeneration((value) => value + 1);
    setSession(nextSession);
    const selected = nextSession.memberships.some((membership) => membership.storeId === preferredStore)
      ? preferredStore!
      : nextSession.memberships[0]?.storeId || "";
    const keepDetail = preferredView === "detail" && Boolean(preferredLessonId) && Boolean(selected);
    updateRoute({ view: keepDetail ? "detail" : "lessons", storeId: selected, lessonId: keepDetail ? preferredLessonId : "" }, true);
    setAuthError("");
  }, [clearSessionCache, updateRoute]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<unknown>("/auth/me")
      .then((payload) => {
        if (!cancelled) {
          try {
            establishSession(payload, initial.storeId, initial.view, initial.lessonId);
          } catch (error) {
            setAuthError(error instanceof Error ? error.message : "Unable to read the current session.");
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && (!(error instanceof ApiError) || error.status !== 401)) {
          setAuthError(error instanceof Error ? error.message : "Unable to connect to the API.");
        }
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    const onPopState = () => {
      const route = initialRoute();
      setView(route.view);
      setActiveStoreId(route.storeId);
      setSelectedLessonId(route.lessonId);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
    // Bootstrap exactly once. `establishSession` updates route state, so making
    // it a dependency would re-run `/auth/me` every time the active store changes.
  }, []);

  const activeMembership = useMemo(
    () => session?.memberships.find((membership) => membership.storeId === activeStoreId),
    [activeStoreId, session?.memberships],
  );
  const effectiveRole = activeMembership?.role || normalizeRole(session?.user.role || session?.user.effectiveRole);
  const cacheScope = `${session?.subject || "anonymous"}:${sessionGeneration}:${activeStoreId}:${effectiveRole}`;
  activeScopeRef.current = cacheScope;

  const handleApiError = useCallback((error: unknown, setError: (message: string) => void) => {
    if (error instanceof ApiError && error.status === 401) {
      expireSession();
      return;
    }
    setError(localizeError(error));
  }, [expireSession]);

  const loadLessons = useCallback(async () => {
    if (!session || !activeStoreId) {
      setLessons([]);
      return;
    }
    const key = `lessons:${cacheScope}:${statusFilter}`;
    const cached = cacheRef.current.get(key);
    if (Array.isArray(cached)) {
      setLessons(cached as Lesson[]);
      return;
    }
    setLessonsLoading(true);
    setLessonsError("");
    try {
      const query = new URLSearchParams();
      if (statusFilter) query.set("status", statusFilter);
      const loaded = extractLessons(await apiFetch<unknown>(`/stores/${encodeURIComponent(activeStoreId)}/lessons?${query.toString()}`));
      if (activeScopeRef.current !== cacheScope) return;
      cacheRef.current.set(key, loaded);
      setLessons(loaded);
      const feedbackEntries = await Promise.all(loaded.map(async (lesson) => {
        const feedbackKey = `feedback:${cacheScope}:${lesson.id}`;
        if (cacheRef.current.has(feedbackKey)) return [lesson.id, cacheRef.current.get(feedbackKey) as Feedback | null] as const;
        try {
          const feedback = extractFeedback(await apiFetch<unknown>(`/lessons/${encodeURIComponent(lesson.id)}/feedback`));
          cacheRef.current.set(feedbackKey, feedback);
          return [lesson.id, feedback] as const;
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status)) return [lesson.id, null] as const;
          throw error;
        }
      }));
      if (activeScopeRef.current === cacheScope) setFeedbackByLesson(Object.fromEntries(feedbackEntries));
    } catch (error) {
      if (activeScopeRef.current === cacheScope) {
        setLessons([]);
        setFeedbackByLesson({});
      }
      handleApiError(error, setLessonsError);
    } finally {
      setLessonsLoading(false);
    }
  }, [activeStoreId, cacheScope, handleApiError, session, statusFilter]);

  useEffect(() => {
    void loadLessons();
  }, [loadLessons]);

  useEffect(() => {
    if (!session || view !== "detail" || !selectedLessonId || !activeStoreId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    setFeedbackMessage("");
    setRequestMessage("");
    const lessonKey = `lesson:${cacheScope}:${selectedLessonId}`;
    const feedbackKey = `feedback:${cacheScope}:${selectedLessonId}`;
    const load = async () => {
      try {
        const cachedLesson = cacheRef.current.get(lessonKey) as Lesson | undefined;
        let lesson: Lesson;
        if (cachedLesson) {
          lesson = cachedLesson;
        } else {
          const payload = await apiFetch<unknown>(`/lessons/${encodeURIComponent(selectedLessonId)}`);
          const record = asRecord(payload);
          const value = (record.lesson || payload) as JsonRecord;
          const id = firstString(value.id, value.lessonId, selectedLessonId) || selectedLessonId;
          lesson = { ...value, id } as Lesson;
        }
        if (lesson.storeId && lesson.storeId !== activeStoreId) throw new ApiError(403, "This lesson belongs to a different active store.");
        cacheRef.current.set(lessonKey, lesson);
        let feedback = cacheRef.current.get(feedbackKey) as Feedback | null | undefined;
        if (feedback === undefined) {
          try {
            feedback = extractFeedback(await apiFetch<unknown>(`/lessons/${encodeURIComponent(selectedLessonId)}/feedback`));
          } catch (error) {
            if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
            if (error instanceof ApiError && error.status === 403) throw error;
            feedback = null;
          }
          cacheRef.current.set(feedbackKey, feedback);
        }
        if (!cancelled) {
          setDetailLesson(lesson);
          setDetailFeedback(feedback || null);
          setFeedbackContent(feedback?.content || "");
        }
      } catch (error) {
        if (!cancelled) handleApiError(error, setDetailError);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [activeStoreId, cacheScope, handleApiError, selectedLessonId, session, view]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    const data = new FormData(event.currentTarget);
    const body: JsonRecord = {
      phone: String(data.get("phone") || "").trim(),
      password: String(data.get("password") || ""),
    };
    if (authMode === "register") body.name = String(data.get("name") || "").trim();
    try {
      await apiFetch<unknown>(authMode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const sessionPayload = await apiFetch<unknown>("/auth/me");
      establishSession(sessionPayload);
    } catch (error) {
      setAuthError(localizeError(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // A server-side expired session is still logged out locally.
    } finally {
      expireSession();
    }
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedLessonId) return;
    setFeedbackBusy(true);
    setFeedbackMessage("");
    try {
      const body: JsonRecord = { content: feedbackContent.trim() };
      const method = detailFeedback ? "PATCH" : "POST";
      const response = await apiFetch<unknown>(`/lessons/${encodeURIComponent(selectedLessonId)}/feedback`, {
        method,
        body: JSON.stringify(body),
      });
      const feedback = extractFeedback(response);
      cacheRef.current.set(`feedback:${cacheScope}:${selectedLessonId}`, feedback);
      setDetailFeedback(feedback);
      setFeedbackByLesson((current) => ({ ...current, [selectedLessonId]: feedback }));
      setFeedbackMessage("피드백이 저장되었습니다.");
    } catch (error) {
      handleApiError(error, setFeedbackMessage);
    } finally {
      setFeedbackBusy(false);
    }
  }

  async function requestFeedback() {
    if (!selectedLessonId) return;
    setRequestBusy(true);
    setRequestMessage("");
    try {
      await apiFetch(`/lessons/${encodeURIComponent(selectedLessonId)}/feedback-request`, { method: "POST" });
      setRequestMessage("피드백 작성 요청을 접수했습니다.");
    } catch (error) {
      handleApiError(error, setRequestMessage);
    } finally {
      setRequestBusy(false);
    }
  }

  if (booting) {
    return <main className="auth-shell"><div className="spinner">Connecting to Lessontalk…</div></main>;
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="brand"><div className="brand-mark">LT</div><h1>Lessontalk</h1></div>
          <section className="card">
            <h2>{authMode === "login" ? "다시 오신 것을 환영합니다" : "계정 만들기"}</h2>
            <p className="muted">{authMode === "login" ? "레슨과 피드백을 확인하려면 로그인하세요." : "새 계정은 회원으로 시작합니다. 매장 접근 권한은 매장 관리자가 부여합니다."}</p>
            {authError && <div className="alert alert-error" role="alert">{authError}</div>}
            <form className="form-grid" onSubmit={submitAuth}>
              {authMode === "register" && <div className="field"><label htmlFor="name">이름</label><input id="name" name="name" required autoComplete="name" /></div>}
              <div className="field"><label htmlFor="phone">전화번호</label><input id="phone" name="phone" required autoComplete="tel" inputMode="tel" placeholder="010-0000-0000" /></div>
              <div className="field"><label htmlFor="password">비밀번호</label><input id="password" name="password" required type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} /></div>
              <button className="btn btn-primary" type="submit" disabled={authBusy}>{authBusy ? "잠시만 기다려주세요…" : authMode === "login" ? "로그인" : "회원가입"}</button>
            </form>
            <div className="auth-toggle">
              <span className="muted small">{authMode === "login" ? "계정이 없으신가요?" : "이미 가입하셨나요?"} </span>
              <button className="btn-link" type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>{authMode === "login" ? "회원가입" : "로그인"}</button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const userName = displayName(session.user, session.subject);
  const isStaff = ["OWNER", "INSTRUCTOR"].includes(effectiveRole);
  const canWrite = isStaff;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="container topbar-inner">
          <button className="brand btn-link" type="button" onClick={() => updateRoute({ view: "lessons", lessonId: "" })} aria-label="레슨 목록으로 이동"><div className="brand-mark">LT</div><h1>Lessontalk</h1></button>
          <div className="user-context">
            {session.memberships.length > 0 && <div className="store-switcher"><label htmlFor="store">현재 매장</label><select id="store" value={activeStoreId} onChange={(event) => { clearSessionCache(); updateRoute({ view: "lessons", storeId: event.target.value, lessonId: "" }); }}><option value="" disabled>매장을 선택하세요</option>{session.memberships.map((membership) => <option value={membership.storeId} key={membership.storeId}>{membership.storeName}</option>)}</select></div>}
            <span className="role-pill">{effectiveRole ? roleLabel(effectiveRole) : "매장 역할 없음"}</span>
            <span className="muted small">{userName}</span>
            <button className="btn btn-secondary" type="button" onClick={() => void logout()}>로그아웃</button>
          </div>
        </div>
      </header>
      <main className="main container">
        {!activeStoreId ? (
          <section className="card empty"><h2>매장 접근 권한 없음</h2><p className="muted">로그인되었지만 소속된 매장이 없습니다. 점주에게 매장 접근 권한을 요청하세요.</p></section>
        ) : view === "detail" ? (
          <LessonDetail
            lesson={detailLesson}
            feedback={detailFeedback}
            loading={detailLoading}
            error={detailError}
            feedbackContent={feedbackContent}
            feedbackBusy={feedbackBusy}
            feedbackMessage={feedbackMessage}
            requestBusy={requestBusy}
            requestMessage={requestMessage}
            canWrite={canWrite}
            canRequest={isStaff}
            onBack={() => updateRoute({ view: "lessons", lessonId: "" })}
            onFeedbackContent={setFeedbackContent}
            onSubmitFeedback={submitFeedback}
            onRequestFeedback={() => void requestFeedback()}
          />
        ) : (
          <section>
            <div className="page-heading">
              <div><h2>레슨</h2><p className="muted">{activeMembership?.storeName || activeStoreId} · {effectiveRole ? roleLabel(effectiveRole) : "소속 승인 대기"}</p></div>
              <div className="stats"><div className="stat"><strong>{lessons.length}</strong><span>조회 가능한 레슨</span></div><div className="stat"><strong>{lessons.filter((lesson) => feedbackByLesson[lesson.id]).length}</strong><span>피드백 작성 완료</span></div></div>
            </div>
            <div className="actions" style={{ marginBottom: 17 }}><label className="field" style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}><span className="muted small">상태</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">전체 레슨</option><option value="RESERVED">예약</option><option value="CHECKED_IN">체크인</option><option value="UNKNOWN">알 수 없음</option><option value="SOURCE_MISSING">원본 누락</option><option value="CANCELED">취소</option></select></label><button className="btn btn-secondary" type="button" onClick={() => { cacheRef.current.clear(); void loadLessons(); }} disabled={lessonsLoading}>새로고침</button></div>
            {lessonsError && <div className="alert alert-error" role="alert">{lessonsError}</div>}
            {lessonsLoading && <div className="spinner">레슨을 불러오는 중…</div>}
            {!lessonsLoading && lessons.length === 0 && !lessonsError && <div className="empty"><h3>레슨이 없습니다</h3><p className="muted">현재 매장과 조건에 맞는 레슨이 없습니다.</p></div>}
            {!lessonsLoading && lessons.length > 0 && <div className="lesson-grid">{lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} feedback={feedbackByLesson[lesson.id]} onOpen={() => updateRoute({ view: "detail", lessonId: lesson.id })} />)}</div>}
          </section>
        )}
      </main>
    </div>
  );
}

function LessonCard({ lesson, feedback, onOpen }: { lesson: Lesson; feedback?: Feedback | null; onOpen: () => void }) {
  const status = firstString(lesson.status, lesson.state) || "UNKNOWN";
  return <article className="card lesson-card"><header><div><h3>{formatDate(lesson.startAt || lesson.lessonDate)}</h3><p className="muted small">레슨 {lesson.id}</p></div><StatusPill value={status} /></header><div className="lesson-meta"><div><strong>회원:</strong> {displayName(lesson.member || asRecord(lesson.memberInfo))}</div><div><strong>프로:</strong> {displayName(lesson.instructor || asRecord(lesson.professor))}</div><div><strong>종료:</strong> {formatDate(lesson.endAt)}</div></div><div className="lesson-footer"><span className="small muted">피드백 <StatusPill value={feedback?.status} fallback={feedback ? "작성 완료" : "미작성"} /></span><button className="btn btn-secondary" type="button" onClick={onOpen}>레슨 보기</button></div></article>;
}

function LessonDetail({ lesson, feedback, loading, error, feedbackContent, feedbackBusy, feedbackMessage, requestBusy, requestMessage, canWrite, canRequest, onBack, onFeedbackContent, onSubmitFeedback, onRequestFeedback }: {
  lesson: Lesson | null;
  feedback: Feedback | null;
  loading: boolean;
  error: string;
  feedbackContent: string;
  feedbackBusy: boolean;
  feedbackMessage: string;
  requestBusy: boolean;
  requestMessage: string;
  canWrite: boolean;
  canRequest: boolean;
  onBack: () => void;
  onFeedbackContent: (value: string) => void;
  onSubmitFeedback: (event: FormEvent<HTMLFormElement>) => void;
  onRequestFeedback: () => void;
}) {
  return <section><div className="back-link"><button className="btn-link" type="button" onClick={onBack}>← 레슨 목록으로</button></div>{loading && <div className="spinner">레슨을 불러오는 중…</div>}{error && <div className="alert alert-error" role="alert">{error}</div>}{!loading && !error && lesson && <div className="detail-layout"><div className="detail-stack"><article className="card"><div className="page-heading" style={{ marginBottom: 0 }}><div><h2>레슨 상세</h2><p className="muted small">{lesson.id}</p></div><StatusPill value={firstString(lesson.status, lesson.state) || "UNKNOWN"} /></div><dl className="detail-list"><dt>시작</dt><dd>{formatDate(lesson.startAt || lesson.lessonDate)}</dd><dt>종료</dt><dd>{formatDate(lesson.endAt)}</dd><dt>회원</dt><dd>{displayName(lesson.member || asRecord(lesson.memberInfo))}</dd><dt>프로</dt><dd>{displayName(lesson.instructor || asRecord(lesson.professor))}</dd><dt>매장</dt><dd>{displayName(lesson.store || asRecord(lesson.storeInfo), lesson.storeId || "—")}</dd></dl></article><article className="card"><div className="page-heading" style={{ marginBottom: 0 }}><div><h3>피드백</h3><p className="muted small">현재 피드백 상태</p></div><StatusPill value={feedback?.status} fallback={feedback ? "작성 완료" : "미작성"} /></div>{feedback ? <><p className="feedback-content">{feedback.content || "작성된 내용이 없습니다."}</p><p className="muted small">{formatDate(feedback.updatedAt || feedback.createdAt)}</p></> : <p className="muted">아직 작성된 피드백이 없습니다.</p>}</article></div><div className="detail-stack">{canWrite && <article className="card"><h3>{feedback ? "피드백 수정" : "피드백 작성"}</h3><p className="muted small">저장 전에 레슨 상태, 담당자, 종료 여부를 확인합니다.</p>{feedbackMessage && <div className={`alert ${feedbackMessage === "피드백이 저장되었습니다." ? "alert-success" : "alert-error"}`} role="status">{feedbackMessage}</div>}<form className="form-grid" onSubmit={onSubmitFeedback}><div className="field"><label htmlFor="feedback-content">피드백 내용</label><textarea id="feedback-content" value={feedbackContent} onChange={(event) => onFeedbackContent(event.target.value)} maxLength={5000} required placeholder="구체적이고 도움이 되는 내용을 작성하세요…" /></div><button className="btn btn-primary" type="submit" disabled={feedbackBusy}>{feedbackBusy ? "저장 중…" : feedback ? "피드백 수정" : "피드백 저장"}</button></form></article>}{canRequest && <article className="card"><h3>피드백 작성 요청</h3><p className="muted small">담당 프로에게 피드백 작성을 요청합니다.</p>{requestMessage && <div className={`alert ${requestMessage === "피드백 작성 요청을 접수했습니다." ? "alert-success" : "alert-error"}`} role="status">{requestMessage}</div>}<button className="btn btn-secondary" type="button" onClick={onRequestFeedback} disabled={requestBusy || Boolean(feedback)}>{requestBusy ? "접수 중…" : feedback ? "피드백이 이미 있습니다" : "작성 요청 보내기"}</button></article>}{!canWrite && <div className="notice">현재 역할에서는 피드백을 수정할 수 없지만 내용을 확인할 수 있습니다.</div>}</div></div>}</section>;
}
