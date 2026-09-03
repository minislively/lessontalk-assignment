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
  rating?: number | null;
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

function StatusPill({ value, fallback = "Not available" }: { value?: unknown; fallback?: string }) {
  const text = String(value || fallback).replaceAll("_", " ");
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
  const [feedbackRating, setFeedbackRating] = useState("");
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
    if (!nextSession) throw new Error("The API returned an invalid session.");
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
    setError(error instanceof Error ? error.message : "The request could not be completed.");
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
          setFeedbackRating(feedback?.rating == null ? "" : String(feedback.rating));
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
      const response = await apiFetch<unknown>(authMode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const sessionPayload = await apiFetch<unknown>("/auth/me");
      establishSession(sessionPayload);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to authenticate.");
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
      if (feedbackRating.trim()) body.rating = Number(feedbackRating);
      const method = detailFeedback ? "PATCH" : "POST";
      const response = await apiFetch<unknown>(`/lessons/${encodeURIComponent(selectedLessonId)}/feedback`, {
        method,
        body: JSON.stringify(body),
      });
      const feedback = extractFeedback(response);
      cacheRef.current.set(`feedback:${cacheScope}:${selectedLessonId}`, feedback);
      setDetailFeedback(feedback);
      setFeedbackByLesson((current) => ({ ...current, [selectedLessonId]: feedback }));
      setFeedbackMessage("Feedback saved.");
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
      setRequestMessage("Feedback request queued.");
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
            <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p className="muted">{authMode === "login" ? "Sign in to view your lessons and feedback." : "New accounts start as members. Store access is granted by your organization."}</p>
            {authError && <div className="alert alert-error" role="alert">{authError}</div>}
            <form className="form-grid" onSubmit={submitAuth}>
              {authMode === "register" && <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required autoComplete="name" /></div>}
              <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" required autoComplete="tel" inputMode="tel" placeholder="010-0000-0000" /></div>
              <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" required type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} /></div>
              <button className="btn btn-primary" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "login" ? "Sign in" : "Register"}</button>
            </form>
            <div className="auth-toggle">
              <span className="muted small">{authMode === "login" ? "Need an account?" : "Already registered?"} </span>
              <button className="btn-link" type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>{authMode === "login" ? "Register" : "Sign in"}</button>
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
          <button className="brand btn-link" type="button" onClick={() => updateRoute({ view: "lessons", lessonId: "" })} aria-label="Go to lessons"><div className="brand-mark">LT</div><h1>Lessontalk</h1></button>
          <div className="user-context">
            {session.memberships.length > 0 && <div className="store-switcher"><label htmlFor="store">Active store</label><select id="store" value={activeStoreId} onChange={(event) => { clearSessionCache(); updateRoute({ view: "lessons", storeId: event.target.value, lessonId: "" }); }}><option value="" disabled>Select a store</option>{session.memberships.map((membership) => <option value={membership.storeId} key={membership.storeId}>{membership.storeName}</option>)}</select></div>}
            <span className="role-pill">{effectiveRole || "NO STORE ROLE"}</span>
            <span className="muted small">{userName}</span>
            <button className="btn btn-secondary" type="button" onClick={() => void logout()}>Log out</button>
          </div>
        </div>
      </header>
      <main className="main container">
        {!activeStoreId ? (
          <section className="card empty"><h2>No store access</h2><p className="muted">Your account is authenticated, but it has no store membership yet. Ask an owner to provision access.</p></section>
        ) : view === "detail" ? (
          <LessonDetail
            lesson={detailLesson}
            feedback={detailFeedback}
            loading={detailLoading}
            error={detailError}
            feedbackContent={feedbackContent}
            feedbackRating={feedbackRating}
            feedbackBusy={feedbackBusy}
            feedbackMessage={feedbackMessage}
            requestBusy={requestBusy}
            requestMessage={requestMessage}
            canWrite={canWrite}
            canRequest={isStaff}
            onBack={() => updateRoute({ view: "lessons", lessonId: "" })}
            onFeedbackContent={setFeedbackContent}
            onFeedbackRating={setFeedbackRating}
            onSubmitFeedback={submitFeedback}
            onRequestFeedback={() => void requestFeedback()}
          />
        ) : (
          <section>
            <div className="page-heading">
              <div><h2>Lessons</h2><p className="muted">{activeMembership?.storeName || activeStoreId} · {effectiveRole || "membership pending"}</p></div>
              <div className="stats"><div className="stat"><strong>{lessons.length}</strong><span>visible lessons</span></div><div className="stat"><strong>{lessons.filter((lesson) => feedbackByLesson[lesson.id]).length}</strong><span>with feedback</span></div></div>
            </div>
            <div className="actions" style={{ marginBottom: 17 }}><label className="field" style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}><span className="muted small">Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All lessons</option><option value="RESERVED">Reserved</option><option value="CHECKED_IN">Checked in</option><option value="COMPLETED">Completed</option><option value="CANCELED">Canceled</option></select></label><button className="btn btn-secondary" type="button" onClick={() => { cacheRef.current.clear(); void loadLessons(); }} disabled={lessonsLoading}>Refresh</button></div>
            {lessonsError && <div className="alert alert-error" role="alert">{lessonsError}</div>}
            {lessonsLoading && <div className="spinner">Loading lessons…</div>}
            {!lessonsLoading && lessons.length === 0 && !lessonsError && <div className="empty"><h3>No lessons found</h3><p className="muted">There are no lessons for this store and filter yet.</p></div>}
            {!lessonsLoading && lessons.length > 0 && <div className="lesson-grid">{lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} feedback={feedbackByLesson[lesson.id]} onOpen={() => updateRoute({ view: "detail", lessonId: lesson.id })} />)}</div>}
          </section>
        )}
      </main>
    </div>
  );
}

function LessonCard({ lesson, feedback, onOpen }: { lesson: Lesson; feedback?: Feedback | null; onOpen: () => void }) {
  const status = firstString(lesson.status, lesson.state) || "UNKNOWN";
  return <article className="card lesson-card"><header><div><h3>{formatDate(lesson.startAt || lesson.lessonDate)}</h3><p className="muted small">Lesson {lesson.id}</p></div><StatusPill value={status} /></header><div className="lesson-meta"><div><strong>Member:</strong> {displayName(lesson.member || asRecord(lesson.memberInfo))}</div><div><strong>Instructor:</strong> {displayName(lesson.instructor || asRecord(lesson.professor))}</div><div><strong>Ends:</strong> {formatDate(lesson.endAt)}</div></div><div className="lesson-footer"><span className="small muted">Feedback <StatusPill value={feedback?.status} fallback={feedback ? "Written" : "Not written"} /></span><button className="btn btn-secondary" type="button" onClick={onOpen}>View lesson</button></div></article>;
}

function LessonDetail({ lesson, feedback, loading, error, feedbackContent, feedbackRating, feedbackBusy, feedbackMessage, requestBusy, requestMessage, canWrite, canRequest, onBack, onFeedbackContent, onFeedbackRating, onSubmitFeedback, onRequestFeedback }: {
  lesson: Lesson | null;
  feedback: Feedback | null;
  loading: boolean;
  error: string;
  feedbackContent: string;
  feedbackRating: string;
  feedbackBusy: boolean;
  feedbackMessage: string;
  requestBusy: boolean;
  requestMessage: string;
  canWrite: boolean;
  canRequest: boolean;
  onBack: () => void;
  onFeedbackContent: (value: string) => void;
  onFeedbackRating: (value: string) => void;
  onSubmitFeedback: (event: FormEvent<HTMLFormElement>) => void;
  onRequestFeedback: () => void;
}) {
  return <section><div className="back-link"><button className="btn-link" type="button" onClick={onBack}>← Back to lessons</button></div>{loading && <div className="spinner">Loading lesson…</div>}{error && <div className="alert alert-error" role="alert">{error}</div>}{!loading && !error && lesson && <div className="detail-layout"><div className="detail-stack"><article className="card"><div className="page-heading" style={{ marginBottom: 0 }}><div><h2>Lesson detail</h2><p className="muted small">{lesson.id}</p></div><StatusPill value={firstString(lesson.status, lesson.state) || "UNKNOWN"} /></div><dl className="detail-list"><dt>Starts</dt><dd>{formatDate(lesson.startAt || lesson.lessonDate)}</dd><dt>Ends</dt><dd>{formatDate(lesson.endAt)}</dd><dt>Member</dt><dd>{displayName(lesson.member || asRecord(lesson.memberInfo))}</dd><dt>Instructor</dt><dd>{displayName(lesson.instructor || asRecord(lesson.professor))}</dd><dt>Store</dt><dd>{displayName(lesson.store || asRecord(lesson.storeInfo), lesson.storeId || "—")}</dd></dl></article><article className="card"><div className="page-heading" style={{ marginBottom: 0 }}><div><h3>Feedback</h3><p className="muted small">Current feedback status</p></div><StatusPill value={feedback?.status} fallback={feedback ? "Written" : "Not written"} /></div>{feedback ? <><p className="feedback-content">{feedback.content || "No written content."}</p><p className="muted small">{feedback.rating != null ? `Rating: ${feedback.rating}/5 · ` : ""}{formatDate(feedback.updatedAt || feedback.createdAt)}</p></> : <p className="muted">No feedback has been submitted for this lesson.</p>}</article></div><div className="detail-stack">{canWrite && <article className="card"><h3>{feedback ? "Update feedback" : "Write feedback"}</h3><p className="muted small">The API validates lesson status, assignment, and completion before saving.</p>{feedbackMessage && <div className={`alert ${feedbackMessage === "Feedback saved." ? "alert-success" : "alert-error"}`} role="status">{feedbackMessage}</div>}<form className="form-grid" onSubmit={onSubmitFeedback}><div className="field"><label htmlFor="feedback-content">Feedback</label><textarea id="feedback-content" value={feedbackContent} onChange={(event) => onFeedbackContent(event.target.value)} maxLength={5000} required placeholder="Share clear, actionable notes…" /></div><div className="field"><label htmlFor="feedback-rating">Rating <span className="muted small">(optional, 1–5)</span></label><input id="feedback-rating" value={feedbackRating} onChange={(event) => onFeedbackRating(event.target.value)} type="number" min="1" max="5" step="1" /></div><button className="btn btn-primary" type="submit" disabled={feedbackBusy}>{feedbackBusy ? "Saving…" : feedback ? "Update feedback" : "Save feedback"}</button></form></article>}{canRequest && <article className="card"><h3>Feedback request</h3><p className="muted small">Ask the assigned instructor to complete feedback. Sending is authorized by the API.</p>{requestMessage && <div className={`alert ${requestMessage === "Feedback request queued." ? "alert-success" : "alert-error"}`} role="status">{requestMessage}</div>}<button className="btn btn-secondary" type="button" onClick={onRequestFeedback} disabled={requestBusy || Boolean(feedback)}>{requestBusy ? "Queueing…" : feedback ? "Feedback already exists" : "Request feedback"}</button></article>}{!canWrite && <div className="notice">You can read this feedback, but your current store role does not allow editing it.</div>}</div></div>}</section>;
}
