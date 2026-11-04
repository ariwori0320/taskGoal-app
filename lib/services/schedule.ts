import { db, isMissingTable } from "../db"
import { newId } from "../id"
import { analyzeDay, expandFixedEvents, type DayAnalysis, type FixedOccurrence } from "../planning"
import {
  ALL_MODES, badRequest, migrationRequired, notFound, requireMode, requireScope, requireVisible, resolveModes,
  type Mode, type Principal,
} from "../principal"
import type { Settings } from "../settings"
import { diffDays, eachDay, isValidWindow, isYmd, nowInTz } from "../time"
import type { FixedEventDb, TaskRow, TimeboxDb } from "../types"
import { cleanText, normDays, optYmd } from "../validate"
import { loadSettings } from "./settings"
import { loadFixedRows } from "./timeboxes"
import { recordEvent } from "../events"

const MAX_RANGE_DAYS = 62

export interface ScheduleResult {
  settings: Settings
  today: string
  nowMinutes: number
  from: string
  to: string
  timeboxes: (TimeboxDb & { task_text: string | null })[]
  fixedEvents: FixedOccurrence[]
  /** カテゴリ別・日別の余白と警告 */
  analysis: Partial<Record<Mode, DayAnalysis[]>>
  /** 画面(UI)のみ: 別カテゴリの予定の「時間だけ」（タイトル・IDは含めない） */
  otherBusy?: { date: string; kind: "fixed" | "planned"; start: number; end: number; minutes?: number }[]
  /** マイグレーション未適用で、タイムボックス機能が使えない */
  migrationRequired?: boolean
}

export interface ScheduleQuery {
  mode?: string | null
  from: string
  to: string
  includeOther?: boolean
}

export async function getSchedule(p: Principal, q: ScheduleQuery): Promise<ScheduleResult> {
  requireScope(p, "read")
  if (!isYmd(q.from) || !isYmd(q.to)) throw badRequest("from / to は YYYY-MM-DD 形式で指定してください")
  if (q.from > q.to) throw badRequest("from は to 以前の日付にしてください")
  if (diffDays(q.from, q.to) + 1 > MAX_RANGE_DAYS) throw badRequest(`一度に取得できるのは${MAX_RANGE_DAYS}日までです`)

  const modes = resolveModes(p, q.mode)
  const settings = await loadSettings(p.userId)
  const now = nowInTz(settings.timezone)
  const base: ScheduleResult = {
    settings, today: now.date, nowMinutes: now.minutes, from: q.from, to: q.to,
    timeboxes: [], fixedEvents: [], analysis: {},
  }
  if (modes.length === 0) return base

  // 余白の計算に使うデータ範囲。AI は許可カテゴリのみ、画面(UI)は全カテゴリ。
  const visible: Mode[] = p.kind === "ui" ? [...ALL_MODES] : p.modes
  let boxes: TimeboxDb[] = []
  try {
    boxes = (await db.find("myflow_timeboxes", [
      ["user_id", "eq", p.userId], ["mode", "in", visible], ["date", "gte", q.from], ["date", "lte", q.to], ["status", "neq", "released"],
    ], { order: "date.asc,window_start.asc", limit: 2000 })) as TimeboxDb[]
  } catch (e) {
    if (!isMissingTable(e)) throw e
    base.migrationRequired = true
  }
  const fixedRows = await loadFixedRows(p.userId, visible)
  const occurrences = expandFixedEvents(fixedRows, q.from, q.to)

  const ownBoxes = boxes.filter(b => modes.includes(b.mode as Mode))
  const ownFixed = occurrences.filter(o => modes.includes(o.mode as Mode))

  // タスク名を付ける（許可カテゴリのタスクのみ）
  const taskIds = Array.from(new Set(ownBoxes.map(b => b.task_id)))
  const titles = new Map<string, string>()
  if (taskIds.length > 0) {
    const tasks = (await db.find("tasks", [["user_id", "eq", p.userId], ["id", "in", taskIds], ["mode", "in", modes]], { limit: 1000 })) as TaskRow[]
    for (const t of tasks) titles.set(t.id, t.text)
  }

  const days = eachDay(q.from, q.to)
  const analysis: ScheduleResult["analysis"] = {}
  for (const m of modes) {
    analysis[m] = days.map(date => analyzeDay({
      date, currentMode: m,
      fixed: occurrences.filter(o => o.date === date),
      timeboxes: boxes.filter(b => b.date === date),
      bufferMinutes: settings.bufferMinutes,
    }))
  }

  const result: ScheduleResult = {
    ...base,
    timeboxes: ownBoxes.map(b => ({ ...b, task_text: titles.get(b.task_id) ?? null })),
    fixedEvents: ownFixed,
    analysis,
  }

  if (p.kind === "ui" && q.includeOther && modes.length === 1) {
    const others = ALL_MODES.filter(m => m !== modes[0])
    result.otherBusy = [
      ...occurrences.filter(o => others.includes(o.mode as Mode)).map(o => ({ date: o.date, kind: "fixed" as const, start: o.start_min, end: o.end_min })),
      ...boxes.filter(b => others.includes(b.mode as Mode) && b.status === "planned").map(b => ({ date: b.date, kind: "planned" as const, start: b.window_start, end: b.window_end, minutes: b.planned_minutes })),
    ]
  }
  return result
}

// ---------- 固定予定 ----------

async function getFixedRow(p: Principal, id: string): Promise<FixedEventDb> {
  let rows: FixedEventDb[]
  try {
    rows = (await db.find("myflow_fixed_events", [["user_id", "eq", p.userId], ["id", "eq", id]], { limit: 1 })) as FixedEventDb[]
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
  if (!rows[0]) throw notFound("固定予定が見つかりません")
  requireVisible(p, rows[0].mode)
  return rows[0]
}

export async function listFixedEvents(p: Principal, mode?: string | null): Promise<FixedEventDb[]> {
  requireScope(p, "read")
  return loadFixedRows(p.userId, resolveModes(p, mode))
}

export interface FixedEventInput {
  mode?: unknown
  title?: unknown
  date?: unknown
  start_min?: unknown
  end_min?: unknown
  repeat_days?: unknown
  until?: unknown
}

export async function createFixedEvent(p: Principal, input: FixedEventInput): Promise<FixedEventDb> {
  requireScope(p, "schedule")
  if (input.mode !== "work" && input.mode !== "private") throw badRequest("mode は work か private を指定してください")
  requireMode(p, input.mode)
  const title = cleanText(input.title, "予定名", 100)
  if (!isValidWindow(input.start_min, input.end_min)) throw badRequest("開始・終了時刻が不正です（開始が終了より前になるよう指定してください）")
  const date = optYmd(input.date, "日付")
  const until = optYmd(input.until, "終了日")
  const repeat = normDays(input.repeat_days)
  if (!repeat && !date) throw badRequest("単発の固定予定には日付が必要です")
  if (date && until && until < date) throw badRequest("終了日は開始日以降にしてください")
  try {
    return (await db.insert("myflow_fixed_events", {
      id: newId("fx_"), user_id: p.userId, mode: input.mode, title,
      date: date ?? null, start_min: input.start_min, end_min: input.end_min, repeat_days: repeat, until: until ?? null,
    })) as FixedEventDb
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
}

export async function updateFixedEvent(p: Principal, id: string, patch: FixedEventInput): Promise<FixedEventDb> {
  requireScope(p, "schedule")
  const cur = await getFixedRow(p, id)
  const title = patch.title !== undefined ? cleanText(patch.title, "予定名", 100) : cur.title
  const start = patch.start_min !== undefined ? patch.start_min : cur.start_min
  const end = patch.end_min !== undefined ? patch.end_min : cur.end_min
  if (!isValidWindow(start, end)) throw badRequest("開始・終了時刻が不正です")
  const date = patch.date !== undefined ? optYmd(patch.date, "日付") ?? null : cur.date
  const until = patch.until !== undefined ? optYmd(patch.until, "終了日") ?? null : cur.until
  const repeat = patch.repeat_days !== undefined ? normDays(patch.repeat_days) : cur.repeat_days
  if (!repeat && !date) throw badRequest("単発の固定予定には日付が必要です")
  if (date && until && until < date) throw badRequest("終了日は開始日以降にしてください")
  return (await db.update("myflow_fixed_events", id, {
    title, start_min: start, end_min: end, date, until, repeat_days: repeat, updated_at: new Date().toISOString(),
  })) as FixedEventDb
}

export async function deleteFixedEvent(p: Principal, id: string) {
  requireScope(p, "delete")
  const cur = await getFixedRow(p, id)
  await db.delete("myflow_fixed_events", id)
  await recordEvent(p, { type: "fixed_event_deleted", mode: cur.mode, payload: { title: cur.title } })
  return { id }
}
