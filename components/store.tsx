"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { ScheduleResult } from "@/lib/services/schedule"
import { describeWarning, type DayAnalysis } from "@/lib/planning"
import { DEFAULT_SETTINGS, windowLabel, type Settings } from "@/lib/settings"
import { isTaskDone } from "@/lib/task-utils"
import { addDays, nowInTz, weekStart } from "@/lib/time"
import type { GoalRow, TaskRow, TimeboxDb } from "@/lib/types"
import type { ToastItem } from "./ui"

export type Mode = "work" | "private"
export type Tab = "home" | "planner" | "tasks" | "goals" | "memos"
export type Schedule = ScheduleResult

export interface MemoRow { id: string; title: string; content: string; tags: string; updated_at: string }
export interface Session { boxId: string; taskId: string; text: string; startedAt: number; minutes: number; mode: Mode }
export interface GoalWithLinks extends GoalRow { linked_total?: number; linked_done?: number }

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const hasBody = init?.body !== undefined
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: hasBody || init?.headers ? { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...init?.headers } : undefined,
    body: hasBody ? JSON.stringify(init!.body) : undefined,
    cache: "no-store",
  })
  const text = await res.text()
  let json: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null } catch { /* JSON でない本文は無視 */ }
  if (!res.ok) throw new ApiError(json?.error ?? `通信エラー (${res.status})`, res.status, json?.code)
  return json as T
}

export interface PlaceInput { date: string; window_start: number; window_end: number; planned_minutes: number }
interface UndoEntry { label: string; run: () => Promise<void> }

const LS = { mode: "myflow.mode", tab: "myflow.tab", session: "myflow.session.v1", sort: "taskSortMode", filter: "taskFilter", fold: "collapsedTaskIds" }
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 保存できない環境では何もしない */ } }

export function useStoreState() {
  const [mode, setModeState] = useState<Mode>("work")
  const [tab, setTabState] = useState<Tab>("home")
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [goals, setGoals] = useState<GoalWithLinks[]>([])
  const [memos, setMemos] = useState<MemoRow[]>([])
  const [yearGoal, setYearGoal] = useState("")
  const [boxes, setBoxes] = useState<TimeboxDb[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [homeSched, setHomeSched] = useState<Schedule | null>(null)
  const [weekSched, setWeekSched] = useState<Schedule | null>(null)
  const [weekFrom, setWeekFromState] = useState<string>("")
  const [showOther, setShowOther] = useState(false)
  const [migration, setMigration] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [session, setSessionState] = useState<Session | null>(null)
  const [undoLen, setUndoLen] = useState(0)
  const [tick, setTick] = useState(0)

  const undoStack = useRef<UndoEntry[]>([])
  const seq = useRef(0)
  const toastId = useRef(0)
  const modeRef = useRef(mode); modeRef.current = mode
  const tabRef = useRef(tab); tabRef.current = tab
  const settingsRef = useRef(settings); settingsRef.current = settings
  const weekFromRef = useRef(weekFrom); weekFromRef.current = weekFrom
  const showOtherRef = useRef(showOther); showOtherRef.current = showOther
  const tasksRef = useRef(tasks); tasksRef.current = tasks
  const boxesRef = useRef(boxes); boxesRef.current = boxes

  // ---- 時計（日付をまたいだら今日が切り替わる） ----
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 30_000); return () => clearInterval(t) }, [])
  const now = useMemo(() => nowInTz(settings.timezone), [settings.timezone, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const today = now.date
  const nowRef = useRef(now); nowRef.current = now

  // ---- トースト ----
  const dismiss = useCallback((id: number) => setToasts(ts => ts.filter(t => t.id !== id)), [])
  const toast = useCallback((text: string, opts: { kind?: "error" | "info"; action?: ToastItem["action"]; ms?: number } = {}) => {
    const id = ++toastId.current
    setToasts(ts => [...ts.slice(-2), { id, text, kind: opts.kind, action: opts.action }])
    setTimeout(() => dismiss(id), opts.ms ?? (opts.action ? 7000 : opts.kind === "error" ? 6000 : 3800))
  }, [dismiss])
  const fail = useCallback((e: unknown, fallback = "保存できませんでした") => {
    if (e instanceof ApiError && e.code === "migration_required") { setMigration(true); toast(e.message, { kind: "error", ms: 8000 }); return }
    toast(e instanceof ApiError ? e.message : fallback, { kind: "error" })
  }, [toast])

  // ---- 読み込み ----
  const labelFor = useCallback((s: number, e: number) => windowLabel(settingsRef.current, s, e), [])

  const fetchSchedules = useCallback(async (m: Mode, withWeek: boolean) => {
    const t = nowRef.current.date
    const home = await api<Schedule>(`/api/planner?mode=${m}&from=${t}&to=${addDays(t, 2)}&includeOther=1`)
    let week: Schedule | null = null
    if (withWeek && tabRef.current === "planner" && weekFromRef.current) {
      const from = weekFromRef.current
      week = await api<Schedule>(`/api/planner?mode=${m}&from=${from}&to=${addDays(from, 6)}&includeOther=1`)
    }
    const bx = await api<TimeboxDb[]>(`/api/timeboxes?mode=${m}&from=${addDays(t, -30)}`)
    return { home, week, bx }
  }, [])

  const loadAll = useCallback(async (m: Mode) => {
    const my = ++seq.current
    setLoading(true)
    try {
      const [t, g, mm, h, sch] = await Promise.all([
        api<TaskRow[]>(`/api/tasks?mode=${m}`),
        api<GoalWithLinks[]>(`/api/goals?mode=${m}`),
        api<MemoRow[]>(`/api/memos?mode=${m}`),
        api<{ year: string }>(`/api/highlights?mode=${m}`),
        fetchSchedules(m, false), // 週は、計画画面を開いたときに画面側が取得する（重複取得を避ける）
      ])
      if (my !== seq.current) return // 古い応答は捨てる（素早いカテゴリ切替での取り違え防止）
      setTasks(Array.isArray(t) ? t : []); setGoals(Array.isArray(g) ? g : []); setMemos(Array.isArray(mm) ? mm : [])
      setYearGoal(h?.year || ""); setHomeSched(sch.home); setBoxes(sch.bx); setSettings(sch.home.settings)
      if (sch.week) setWeekSched(sch.week)
      setMigration(!!sch.home.migrationRequired)
      setReady(true)
    } catch (e) {
      if (my !== seq.current) return
      // 失敗時は前のカテゴリの内容を残さない（別カテゴリの内容が見え続けるのを防ぐ）
      setTasks([]); setGoals([]); setMemos([]); setYearGoal(""); setBoxes([]); setHomeSched(null); setWeekSched(null)
      setReady(true)
      fail(e, "読み込めませんでした")
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [fetchSchedules, fail])

  /** 予定まわりだけを取り直す（タスクを変更したあと・予定を動かしたあと） */
  const refresh = useCallback(async () => {
    const m = modeRef.current
    const my = seq.current
    try {
      const sch = await fetchSchedules(m, true)
      if (my !== seq.current || m !== modeRef.current) return
      setHomeSched(sch.home); setBoxes(sch.bx); if (sch.week) setWeekSched(sch.week)
      setMigration(!!sch.home.migrationRequired)
    } catch (e) { fail(e, "予定を更新できませんでした") }
  }, [fetchSchedules, fail])

  const reloadTasks = useCallback(async () => {
    const m = modeRef.current
    try { const t = await api<TaskRow[]>(`/api/tasks?mode=${m}`); if (m === modeRef.current) setTasks(t) } catch (e) { fail(e, "読み込めませんでした") }
  }, [fail])

  // 起動時: 前回のカテゴリ・画面・進行中の取り組みを復元
  useEffect(() => {
    const m = lsGet(LS.mode); const t = lsGet(LS.tab)
    const initialMode: Mode = m === "private" ? "private" : "work"
    if (t === "home" || t === "planner" || t === "tasks" || t === "goals" || t === "memos") setTabState(t)
    try { const s = JSON.parse(lsGet(LS.session) || "null"); if (s && s.boxId && s.mode === initialMode) setSessionState(s) } catch { /* 壊れた値は無視 */ }
    setModeState(initialMode)
    modeRef.current = initialMode
    setWeekFromState(weekStart(nowInTz(DEFAULT_SETTINGS.timezone).date))
    loadAll(initialMode)
  }, [loadAll])

  const setMode = useCallback((m: Mode) => {
    if (m === modeRef.current) return
    modeRef.current = m
    setModeState(m); lsSet(LS.mode, m)
    // 別カテゴリの内容を一瞬でも見せない
    setTasks([]); setGoals([]); setMemos([]); setBoxes([]); setHomeSched(null); setWeekSched(null); setYearGoal("")
    undoStack.current = []; setUndoLen(0)
    let s: Session | null = null
    try { const j = JSON.parse(lsGet(LS.session) || "null"); if (j && j.mode === m) s = j } catch { /* 無視 */ }
    setSessionState(s)
    loadAll(m)
  }, [loadAll])

  const setTab = useCallback((t: Tab) => { setTabState(t); tabRef.current = t; lsSet(LS.tab, t) }, [])

  const loadWeek = useCallback(async (from: string) => {
    const m = modeRef.current
    try {
      const w = await api<Schedule>(`/api/planner?mode=${m}&from=${from}&to=${addDays(from, 6)}&includeOther=1`)
      if (m === modeRef.current && from === weekFromRef.current) setWeekSched(w)
    } catch (e) { fail(e, "週の予定を読み込めませんでした") }
  }, [fail])

  const setWeekFrom = useCallback((d: string) => { setWeekFromState(d); weekFromRef.current = d }, [])
  useEffect(() => { if (ready && tab === "planner" && weekFrom) loadWeek(weekFrom) }, [ready, tab, weekFrom, mode, loadWeek])

  // ---- 取り消し ----
  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStack.current = [...undoStack.current.slice(-19), entry]; setUndoLen(undoStack.current.length)
  }, [])
  const undo = useCallback(async () => {
    const e = undoStack.current.pop(); setUndoLen(undoStack.current.length)
    if (!e) return
    try { await e.run(); toast(`${e.label}を元に戻しました`) } catch (err) { fail(err, "元に戻せませんでした") }
    await refresh()
  }, [refresh, toast, fail])

  const warnAfter = useCallback((analysis?: DayAnalysis) => {
    const w = analysis?.warnings?.[0]
    if (w) toast(`⚠ ${describeWarning(w, labelFor)}`, { ms: 6500 })
  }, [toast, labelFor])

  // ---- タスク ----
  const flashDone = useCallback((id: string) => {
    setFlash(s => new Set(s).add(id))
    setTimeout(() => setFlash(s => { const n = new Set(s); n.delete(id); return n }), 1300)
  }, [])

  const addTask = useCallback(async (input: Record<string, unknown>): Promise<TaskRow | null> => {
    try {
      const row = await api<TaskRow>("/api/tasks", { method: "POST", body: { mode: modeRef.current, ...input } })
      setTasks(prev => [row, ...prev])
      return row
    } catch (e) { fail(e, "追加できませんでした"); return null }
  }, [fail])

  const saveTask = useCallback(async (id: string, patch: Record<string, unknown>): Promise<TaskRow | null> => {
    const before = tasksRef.current
    if (!("mode" in patch)) setTasks(prev => prev.map(t => (t.id === id ? ({ ...t, ...patch } as TaskRow) : t)))
    try {
      const row = await api<TaskRow>(`/api/tasks/${id}`, { method: "PATCH", body: patch })
      if (row.mode !== modeRef.current) {
        const gone = new Set<string>([id])
        for (let i = 0; i < 4; i++) tasksRef.current.forEach(t => { if (t.parent_id && gone.has(t.parent_id)) gone.add(t.id) })
        setTasks(prev => prev.filter(t => !gone.has(t.id)))
        toast(`「${row.text}」を${row.mode === "work" ? "仕事" : "プライベート"}へ移しました`)
        refresh()
      } else {
        setTasks(prev => prev.map(t => (t.id === id ? row : t)))
        if ("estimate_minutes" in patch || "mode" in patch) refresh()
      }
      return row
    } catch (e) { setTasks(before); fail(e); return null }
  }, [fail, toast, refresh])

  const toggleTask = useCallback(async (task: TaskRow) => {
    const t = nowRef.current.date
    const next = !isTaskDone(task, t)
    setTasks(prev => prev.map(x => x.id !== task.id ? x : (x.is_recurring ? { ...x, recurring_done_date: next ? t : null } : { ...x, done: next })))
    if (next) flashDone(task.id)
    try {
      const res = await api<{ task: TaskRow; timebox: TimeboxDb | null; releasedTimeboxes: number; restoredTimeboxes?: number }>(`/api/tasks/${task.id}/complete`, { method: "POST", body: { done: next } })
      setTasks(prev => prev.map(x => (x.id === task.id ? res.task : x)))
      // 予定が動いたとき（今日の分が実施済みに/残りが解放/戻したときに復元）は予定を取り直す
      if (res.releasedTimeboxes > 0 || (res.restoredTimeboxes ?? 0) > 0 || res.timebox || boxesRef.current.some(b => b.task_id === task.id)) refresh()
    } catch (e) { fail(e, "完了を保存できませんでした"); reloadTasks() }
  }, [fail, flashDone, refresh, reloadTasks])

  const deleteTask = useCallback(async (id: string) => {
    const gone = new Set<string>([id])
    for (let i = 0; i < 4; i++) tasksRef.current.forEach(t => { if (t.parent_id && gone.has(t.parent_id)) gone.add(t.id) })
    setTasks(prev => prev.filter(t => !gone.has(t.id)))
    try { await api(`/api/tasks/${id}`, { method: "DELETE" }); refresh() } catch (e) { fail(e, "削除できませんでした"); reloadTasks() }
  }, [fail, refresh, reloadTasks])

  /** 手動の並び順: 移動した1件だけを前後の中間値に。値が詰まったときだけ全体を採番し直す。 */
  const reorderTasks = useCallback(async (srcId: string, overId: string, visible: TaskRow[], allRoots: TaskRow[]) => {
    if (!srcId || !overId || srcId === overId) return
    const from = visible.findIndex(t => t.id === srcId), to = visible.findIndex(t => t.id === overId)
    if (from === -1 || to === -1) return
    const moved = [...visible]; const [src] = moved.splice(from, 1); moved.splice(to, 0, src)
    const pv = typeof moved[to - 1]?.sort_order === "number" ? (moved[to - 1].sort_order as number) : null
    const nv = typeof moved[to + 1]?.sort_order === "number" ? (moved[to + 1].sort_order as number) : null
    let val: number | null = null
    if (pv === null && nv !== null) val = nv - 1
    else if (pv !== null && nv === null) val = pv + 1
    else if (pv !== null && nv !== null && nv - pv > 1e-6) val = (pv + nv) / 2
    try {
      if (val !== null) {
        setTasks(prev => prev.map(t => (t.id === srcId ? { ...t, sort_order: val } : t)))
        await api(`/api/tasks/${srcId}`, { method: "PATCH", body: { sort_order: val } })
        return
      }
      const rest = allRoots.filter(t => t.id !== srcId)
      const oi = rest.findIndex(t => t.id === overId)
      rest.splice(oi === -1 ? rest.length : (from < to ? oi + 1 : oi), 0, src)
      const order = new Map(rest.map((t, i) => [t.id, i]))
      setTasks(prev => prev.map(t => (order.has(t.id) ? { ...t, sort_order: order.get(t.id)! } : t)))
      await Promise.all(rest.map((t, i) => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { sort_order: i } })))
    } catch (e) { fail(e, "並び順を保存できませんでした"); reloadTasks() }
  }, [fail, reloadTasks])

  // ---- 予定（タイムボックス） ----
  const afterBox = useCallback(async (analysis?: DayAnalysis) => { await refresh(); warnAfter(analysis) }, [refresh, warnAfter])

  const placeTask = useCallback(async (taskId: string, input: PlaceInput): Promise<boolean> => {
    try {
      const res = await api<{ timebox: TimeboxDb; analysis: DayAnalysis }>("/api/timeboxes", { method: "POST", body: { task_id: taskId, ...input } })
      const id = res.timebox.id
      pushUndo({ label: "予定の追加", run: async () => { await api(`/api/timeboxes/${id}`, { method: "DELETE" }) } })
      await afterBox(res.analysis)
      toast("予定に入れました", { action: { label: "元に戻す", run: () => { undo() } } })
      return true
    } catch (e) { fail(e, "予定に入れられませんでした"); return false }
  }, [afterBox, fail, pushUndo, toast, undo])

  const moveBox = useCallback(async (id: string, patch: Partial<PlaceInput>, label = "予定の変更", quiet = false): Promise<boolean> => {
    const prev = boxesRef.current.find(b => b.id === id)
    try {
      const res = await api<{ timebox: TimeboxDb; analysis: DayAnalysis }>(`/api/timeboxes/${id}`, { method: "PATCH", body: patch })
      if (prev) {
        const back = { date: prev.date, window_start: prev.window_start, window_end: prev.window_end, planned_minutes: prev.planned_minutes }
        pushUndo({ label, run: async () => { await api(`/api/timeboxes/${id}`, { method: "PATCH", body: back }) } })
      }
      await afterBox(res.analysis)
      if (!quiet) toast(`${label}をしました`, { action: { label: "元に戻す", run: () => { undo() } } })
      return true
    } catch (e) { fail(e, "予定を変更できませんでした"); await refresh(); return false }
  }, [afterBox, fail, pushUndo, refresh, toast, undo])

  const releaseBox = useCallback(async (id: string) => {
    const prev = boxesRef.current.find(b => b.id === id)
    try {
      await api(`/api/timeboxes/${id}`, { method: "DELETE" })
      if (prev) {
        const body = { task_id: prev.task_id, date: prev.date, window_start: prev.window_start, window_end: prev.window_end, planned_minutes: prev.planned_minutes }
        pushUndo({ label: "未配置への変更", run: async () => { await api("/api/timeboxes", { method: "POST", body }) } })
      }
      await refresh()
      toast("未配置に戻しました", { action: { label: "元に戻す", run: () => { undo() } } })
    } catch (e) { fail(e); await refresh() }
  }, [fail, pushUndo, refresh, toast, undo])

  const unplaceTask = useCallback(async (taskId: string) => {
    const prev = boxesRef.current.filter(b => b.task_id === taskId && b.status === "planned")
    try {
      await api(`/api/tasks/${taskId}/unplace`, { method: "POST" })
      if (prev.length > 0) {
        pushUndo({ label: "未配置への変更", run: async () => {
          for (const b of prev) await api("/api/timeboxes", { method: "POST", body: { task_id: b.task_id, date: b.date, window_start: b.window_start, window_end: b.window_end, planned_minutes: b.planned_minutes } })
        } })
      }
      await refresh()
      toast("未配置に戻しました", { action: { label: "元に戻す", run: () => { undo() } } })
    } catch (e) { fail(e); await refresh() }
  }, [fail, pushUndo, refresh, toast, undo])

  const completeBox = useCallback(async (id: string, actualMinutes?: number) => {
    try {
      await api(`/api/timeboxes/${id}/complete`, { method: "POST", body: actualMinutes !== undefined ? { actual_minutes: actualMinutes } : {} })
      await refresh()
      toast("今日の分を実施済みにしました")
    } catch (e) { fail(e); await refresh() }
  }, [fail, refresh, toast])

  const splitBox = useCallback(async (id: string, input: { minutes: number; date?: string; window_start?: number; window_end?: number }): Promise<boolean> => {
    try {
      const res = await api<{ original: TimeboxDb; created: TimeboxDb }>(`/api/timeboxes/${id}/split`, { method: "POST", body: input })
      const prevMin = res.original.planned_minutes + input.minutes
      pushUndo({ label: "予定の分割", run: async () => {
        await api(`/api/timeboxes/${res.created.id}`, { method: "DELETE" })
        await api(`/api/timeboxes/${id}`, { method: "PATCH", body: { planned_minutes: prevMin } })
      } })
      await refresh()
      toast("予定を分けました", { action: { label: "元に戻す", run: () => { undo() } } })
      return true
    } catch (e) { fail(e, "分けられませんでした"); return false }
  }, [fail, pushUndo, refresh, toast, undo])

  // ---- 取り組み中（今から始める） ----
  const setSession = useCallback((s: Session | null) => {
    setSessionState(s); lsSet(LS.session, JSON.stringify(s))
  }, [])

  /** 今から始める。予定を「いま〜」に移し、取り組み中の表示を出す（minutes 指定で短時間だけ）。 */
  const startNow = useCallback(async (boxId: string, minutes?: number): Promise<boolean> => {
    const box = boxesRef.current.find(b => b.id === boxId)
    const task = box ? tasksRef.current.find(t => t.id === box.task_id) : undefined
    if (!box || !task) return false
    const n = nowRef.current
    const mins = Math.max(1, Math.min(minutes ?? box.planned_minutes, 480))
    const start = Math.min(1439 - 1, Math.floor(n.minutes / 5) * 5)
    const end = Math.min(1440, Math.max(start + mins, start + 1))
    const planned = Math.min(mins, end - start)
    const ok = await moveBox(boxId, { date: n.date, window_start: start, window_end: end, planned_minutes: planned }, "今から始める", true)
    if (ok) setSession({ boxId, taskId: task.id, text: task.text, startedAt: Date.now(), minutes: planned, mode: modeRef.current })
    return ok
  }, [moveBox, setSession])

  // ---- 固定予定・設定 ----
  const saveFixed = useCallback(async (id: string | null, input: Record<string, unknown>): Promise<boolean> => {
    try {
      if (id) await api(`/api/fixed-events/${id}`, { method: "PATCH", body: input })
      else await api("/api/fixed-events", { method: "POST", body: { mode: modeRef.current, ...input } })
      await refresh(); return true
    } catch (e) { fail(e); return false }
  }, [fail, refresh])

  const deleteFixed = useCallback(async (id: string) => {
    try { await api(`/api/fixed-events/${id}`, { method: "DELETE" }); await refresh() } catch (e) { fail(e) }
  }, [fail, refresh])

  const saveSettings = useCallback(async (patch: Partial<Settings>): Promise<boolean> => {
    try {
      const { carryover, ...s } = await api<Settings & { carryover?: { moved: number; skipped: number } }>("/api/settings", { method: "PATCH", body: patch })
      setSettings(s); await refresh()
      if (carryover && (carryover.moved || carryover.skipped)) {
        const parts = []
        if (carryover.moved) parts.push(`${carryover.moved}件の予定を新しい時間帯に合わせました`)
        if (carryover.skipped) parts.push(`${carryover.skipped}件は作業時間が収まらないため元の時間のままです`)
        toast(parts.join("。"), { ms: 6000 })
      }
      return true
    } catch (e) { fail(e); return false }
  }, [fail, refresh, toast])

  // ---- 目標・メモ ----
  const pctTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const addGoal = useCallback(async (text: string, due: string): Promise<boolean> => {
    try {
      const g = await api<GoalRow>("/api/goals", { method: "POST", body: { text, due_date: due || null, mode: modeRef.current } })
      if (!g?.id) throw new Error("bad")
      setGoals(prev => [g, ...prev]); return true
    } catch (e) { fail(e, "目標を追加できませんでした"); return false }
  }, [fail])
  const setGoalPct = useCallback((id: string, pct: number) => {
    setGoals(prev => prev.map(g => (g.id === id ? { ...g, pct } : g)))
    clearTimeout(pctTimers.current[id])
    pctTimers.current[id] = setTimeout(() => { api(`/api/goals/${id}`, { method: "PATCH", body: { pct } }).catch(e => fail(e, "進捗を保存できませんでした")) }, 400)
  }, [fail])
  const saveGoal = useCallback(async (id: string, patch: Record<string, unknown>) => {
    setGoals(prev => prev.map(g => (g.id === id ? ({ ...g, ...patch } as GoalWithLinks) : g)))
    try { await api(`/api/goals/${id}`, { method: "PATCH", body: patch }) } catch (e) { fail(e, "目標を保存できませんでした") }
  }, [fail])
  const deleteGoal = useCallback(async (id: string) => {
    setGoals(prev => prev.filter(g => g.id !== id))
    try { await api(`/api/goals/${id}`, { method: "DELETE" }) } catch (e) { fail(e, "削除できませんでした") }
  }, [fail])
  const saveYearGoal = useCallback(async (text: string) => {
    setYearGoal(text)
    try { await api("/api/highlights", { method: "PATCH", body: { mode: modeRef.current, year_text: text } }) } catch (e) { fail(e) }
  }, [fail])

  const saveMemo = useCallback(async (id: string | null, body: { title: string; content: string; tags: string }): Promise<MemoRow | null> => {
    try {
      if (id) {
        await api(`/api/memos/${id}`, { method: "PATCH", body })
        const next = { ...(memos.find(m => m.id === id) as MemoRow), ...body }
        setMemos(prev => prev.map(m => (m.id === id ? next : m)))
        return next
      }
      const m = await api<MemoRow>("/api/memos", { method: "POST", body: { ...body, mode: modeRef.current } })
      if (!m?.id) throw new Error("bad")
      setMemos(prev => [m, ...prev]); return m
    } catch (e) { fail(e, "メモを保存できませんでした"); return null }
  }, [fail, memos])
  const deleteMemo = useCallback(async (id: string) => {
    setMemos(prev => prev.filter(m => m.id !== id))
    try { await api(`/api/memos/${id}`, { method: "DELETE" }) } catch (e) { fail(e, "削除できませんでした") }
  }, [fail])

  // ---- 派生 ----
  const childrenOf = useMemo(() => {
    const m = new Map<string, TaskRow[]>()
    for (const t of tasks) if (t.parent_id) { const a = m.get(t.parent_id); if (a) a.push(t); else m.set(t.parent_id, [t]) }
    return m
  }, [tasks])
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])
  const boxesByTask = useMemo(() => {
    const m = new Map<string, TimeboxDb[]>()
    for (const b of boxes) { const a = m.get(b.task_id); if (a) a.push(b); else m.set(b.task_id, [b]) }
    return m
  }, [boxes])

  // 未配置: 繰り返しでなく、未完了で、サブタスクを持たず、予定(planned)が1つも無いタスク。期限が早い順 → 優先度順。
  const unplaced = useMemo(() => {
    const rank: Record<string, number> = { high: 0, mid: 1, low: 2 }
    return tasks
      .filter(t => !t.is_recurring && !isTaskDone(t, today) && !(childrenOf.get(t.id)?.length) && !(boxesByTask.get(t.id) ?? []).some(b => b.status === "planned"))
      .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1))
  }, [tasks, childrenOf, boxesByTask, today])

  return {
    mode, setMode, tab, setTab, ready, loading, tasks, goals, memos, yearGoal, boxes, settings, today, now,
    homeSched, weekSched, weekFrom, setWeekFrom, showOther, setShowOther, migration, toasts, dismiss, toast, flash, session, setSession,
    undoLen, undo, childrenOf, taskById, boxesByTask, unplaced,
    reload: () => loadAll(modeRef.current), refresh,
    addTask, saveTask, toggleTask, deleteTask, reorderTasks,
    placeTask, moveBox, releaseBox, unplaceTask, completeBox, splitBox, startNow,
    saveFixed, deleteFixed, saveSettings,
    addGoal, setGoalPct, saveGoal, deleteGoal, saveYearGoal, saveMemo, deleteMemo,
    sortKey: LS.sort, filterKey: LS.filter, foldKey: LS.fold,
  }
}

export type Store = ReturnType<typeof useStoreState>
const Ctx = createContext<Store | null>(null)
export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreState()
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export function useStore(): Store {
  const v = useContext(Ctx)
  if (!v) throw new Error("StoreProvider が必要です")
  return v
}
