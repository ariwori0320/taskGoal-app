import { db, isMissingTable, type Cond } from "../db"
import { recordEvent } from "../events"
import { newId } from "../id"
import { analyzeDay, expandFixedEvents, type DayAnalysis } from "../planning"
import {
  ALL_MODES, badRequest, migrationRequired, requireScope, resolveModes,
  type Mode, type Principal,
} from "../principal"
import { presetForWindow, type Settings } from "../settings"
import { addDays, isValidPlannedMinutes, isValidWindow, isYmd, nowInTz } from "../time"
import type { FixedEventDb, TimeboxDb } from "../types"
import { getTaskRow, getTimeboxRow } from "./rows"
import { loadSettings } from "./settings"
import { isTaskDone } from "./tasks"

/** 固定予定を読む。テーブル未作成なら空。 */
export async function loadFixedRows(userId: string, modes: Mode[]): Promise<FixedEventDb[]> {
  if (modes.length === 0) return []
  try {
    return (await db.find("myflow_fixed_events", [["user_id", "eq", userId], ["mode", "in", modes]], { limit: 500 })) as FixedEventDb[]
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
}

/**
 * その日の余白・警告を計算する。
 * 別カテゴリとの競合は「画面(UI)」のときだけ全カテゴリで計算する。
 * AI には、許可されたカテゴリのデータしか使わない（許可外カテゴリの存在を推測させない）。
 */
export async function analyzeDate(p: Principal, date: string, mode: Mode, settings: Settings): Promise<DayAnalysis> {
  const visible: Mode[] = p.kind === "ui" ? [...ALL_MODES] : p.modes
  const boxes = (await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["date", "eq", date], ["mode", "in", visible]], { limit: 500 })) as TimeboxDb[]
  const fixed = expandFixedEvents(await loadFixedRows(p.userId, visible), date, date)
  return analyzeDay({ date, currentMode: mode, fixed, timeboxes: boxes, bufferMinutes: settings.bufferMinutes })
}

function requireTable<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch(e => {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  })
}

function validateBox(date: unknown, start: unknown, end: unknown, planned: unknown) {
  if (!isYmd(date)) throw badRequest("実施日は YYYY-MM-DD 形式で指定してください")
  if (!isValidWindow(start, end)) throw badRequest("時間帯は 0:00〜24:00 の範囲で、開始が終了より前になるよう指定してください")
  if (!isValidPlannedMinutes(planned)) throw badRequest("予定作業時間は1〜1440分の整数で指定してください")
  if ((planned as number) > (end as number) - (start as number)) throw badRequest("時間帯より長い作業時間は設定できません")
}

// ---------- 取得 ----------

export interface ListTimeboxesQuery {
  mode?: string | null
  from?: string
  to?: string
  task_id?: string
  status?: "planned" | "done" | "released" | "active"
  /** from より前でも、未実施(planned)の予定は含める（古い予定のあるタスクが「未配置」に見えないように） */
  keepOpen?: boolean
}

export async function listTimeboxes(p: Principal, q: ListTimeboxesQuery = {}): Promise<TimeboxDb[]> {
  requireScope(p, "read")
  const modes = resolveModes(p, q.mode)
  if (modes.length === 0) return []
  if (q.from && !isYmd(q.from)) throw badRequest("from は YYYY-MM-DD 形式で指定してください")
  if (q.to && !isYmd(q.to)) throw badRequest("to は YYYY-MM-DD 形式で指定してください")
  const conds: Cond[] = [["user_id", "eq", p.userId], ["mode", "in", modes]]
  if (q.from) conds.push(["date", "gte", q.from])
  if (q.to) conds.push(["date", "lte", q.to])
  if (q.task_id) conds.push(["task_id", "eq", q.task_id])
  if (q.status && q.status !== "active") conds.push(["status", "eq", q.status])
  if (q.status === "active" || !q.status) conds.push(["status", "neq", "released"])
  try {
    const rows = (await db.find("myflow_timeboxes", conds, { order: "date.asc,window_start.asc", limit: 2000 })) as TimeboxDb[]
    if (q.keepOpen && q.from && !q.status) {
      const old = (await db.find("myflow_timeboxes", [
        ["user_id", "eq", p.userId], ["mode", "in", modes], ["status", "eq", "planned"], ["date", "lt", q.from],
        ...(q.task_id ? [["task_id", "eq", q.task_id] as Cond] : []),
      ], { order: "date.asc,window_start.asc", limit: 2000 })) as TimeboxDb[]
      return [...old, ...rows]
    }
    return rows
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
}

// ---------- 作成 ----------

export interface CreateTimeboxInput {
  task_id?: unknown
  date?: unknown
  window_start?: unknown
  window_end?: unknown
  planned_minutes?: unknown
}

export async function createTimebox(p: Principal, input: CreateTimeboxInput) {
  requireScope(p, "schedule")
  if (typeof input.task_id !== "string" || !input.task_id) throw badRequest("task_id は必須です")
  const task = await getTaskRow(p, input.task_id) // 権限の無いカテゴリのタスクは 404
  const settings = await loadSettings(p.userId)
  const now = nowInTz(settings.timezone)
  if (!task.is_recurring && isTaskDone(task, now.date)) throw badRequest("完了済みのタスクには予定を入れられません")
  validateBox(input.date, input.window_start, input.window_end, input.planned_minutes)

  const preset = presetForWindow(settings, input.window_start as number, input.window_end as number)?.key ?? "custom"
  const box = await requireTable(() => db.insert("myflow_timeboxes", {
    id: newId("tb_"),
    user_id: p.userId,
    mode: task.mode, // タイムボックスの所属は常にタスクと同じ
    task_id: task.id,
    date: input.date,
    window_start: input.window_start,
    window_end: input.window_end,
    preset,
    planned_minutes: input.planned_minutes,
    status: "planned",
  })) as TimeboxDb
  await recordEvent(p, { type: "timebox_created", mode: box.mode, task_id: task.id, timebox_id: box.id, payload: { date: box.date, window: [box.window_start, box.window_end], minutes: box.planned_minutes } })
  const analysis = await analyzeDate(p, box.date, box.mode as Mode, settings)
  return { timebox: box, analysis }
}

// ---------- 変更（移動・時間帯変更・所要時間変更） ----------

export interface UpdateTimeboxInput {
  date?: unknown
  window_start?: unknown
  window_end?: unknown
  planned_minutes?: unknown
}

export async function updateTimebox(p: Principal, id: string, patch: UpdateTimeboxInput) {
  requireScope(p, "schedule")
  const box = await getTimeboxRow(p, id)
  if (box.status !== "planned") throw badRequest("実施済み・解放済みの予定は変更できません")

  const date = patch.date !== undefined ? patch.date : box.date
  const start = patch.window_start !== undefined ? patch.window_start : box.window_start
  const end = patch.window_end !== undefined ? patch.window_end : box.window_end
  const planned = patch.planned_minutes !== undefined ? patch.planned_minutes : box.planned_minutes
  if (patch.date === undefined && patch.window_start === undefined && patch.window_end === undefined && patch.planned_minutes === undefined) {
    throw badRequest("変更内容が指定されていません")
  }
  validateBox(date, start, end, planned)

  const settings = await loadSettings(p.userId)
  const preset = presetForWindow(settings, start as number, end as number)?.key ?? "custom"
  const updated = await requireTable(() => db.update("myflow_timeboxes", id, {
    date, window_start: start, window_end: end, planned_minutes: planned, preset, updated_at: new Date().toISOString(),
  })) as TimeboxDb

  const dateChanged = date !== box.date
  const windowChanged = start !== box.window_start || end !== box.window_end
  const minutesChanged = planned !== box.planned_minutes
  if (dateChanged && (date as string) > box.date) {
    // 後ろの日付への移動は「先送り」として数える
    await recordEvent(p, { type: "timebox_postponed", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { from: box.date, to: date } })
  } else if (dateChanged || windowChanged) {
    await recordEvent(p, { type: "timebox_moved", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { from: { date: box.date, window: [box.window_start, box.window_end] }, to: { date, window: [start, end] } } })
  }
  if (minutesChanged) {
    await recordEvent(p, { type: "timebox_resized", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { from: box.planned_minutes, to: planned } })
  }
  const analysis = await analyzeDate(p, updated.date, updated.mode as Mode, settings)
  return { timebox: updated, analysis }
}

// ---------- 未配置に戻す ----------

export async function releaseTimebox(p: Principal, id: string) {
  requireScope(p, "schedule")
  const box = await getTimeboxRow(p, id)
  await db.delete("myflow_timeboxes", id)
  await recordEvent(p, { type: "timebox_unplaced", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { date: box.date } })
  return { id }
}

/** タスクの予定(planned)をすべて外して「未配置」に戻す */
export async function unplaceTask(p: Principal, taskId: string) {
  requireScope(p, "schedule")
  const task = await getTaskRow(p, taskId)
  const boxes = await requireTable(() => db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "eq", taskId], ["status", "eq", "planned"]], { limit: 500 })) as TimeboxDb[]
  if (boxes.length > 0) {
    await db.deleteWhere("myflow_timeboxes", [["user_id", "eq", p.userId], ["id", "in", boxes.map(b => b.id)]])
    await recordEvent(p, { type: "task_unplaced", mode: task.mode, task_id: taskId, payload: { removed: boxes.length } })
  }
  return { task_id: taskId, removed: boxes.length }
}

// ---------- 今日はここまで（予定の実施。タスクは完了にしない） ----------

export async function completeTimebox(p: Principal, id: string, opts: { actual_minutes?: unknown } = {}) {
  requireScope(p, "complete")
  const box = await getTimeboxRow(p, id)
  if (box.status !== "planned") throw badRequest("この予定はすでに実施済みか、解放済みです")
  let actual = box.planned_minutes
  if (opts.actual_minutes !== undefined && opts.actual_minutes !== null) {
    if (!Number.isInteger(opts.actual_minutes) || (opts.actual_minutes as number) < 0 || (opts.actual_minutes as number) > 1440) {
      throw badRequest("実際にかかった時間は0〜1440分の整数で指定してください")
    }
    actual = opts.actual_minutes as number
  }
  const settings = await loadSettings(p.userId)
  const now = nowInTz(settings.timezone)
  const kept = box.date === now.date && now.minutes >= box.window_start && now.minutes <= box.window_end
  const updated = (await db.update("myflow_timeboxes", id, {
    status: "done", completed_at: new Date().toISOString(), actual_minutes: actual, kept_window: kept, updated_at: new Date().toISOString(),
  })) as TimeboxDb
  await recordEvent(p, { type: "timebox_done", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { kept_window: kept, actual_minutes: actual } })
  return { timebox: updated }
}

// ---------- 分割（120分を 30/60/30 のように複数日へ） ----------

export interface SplitTimeboxInput {
  minutes?: unknown
  date?: unknown
  window_start?: unknown
  window_end?: unknown
}

export async function splitTimebox(p: Principal, id: string, input: SplitTimeboxInput) {
  requireScope(p, "schedule")
  const box = await getTimeboxRow(p, id)
  if (box.status !== "planned") throw badRequest("実施済み・解放済みの予定は分割できません")
  const minutes = input.minutes
  if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) >= box.planned_minutes) {
    throw badRequest(`分割する時間は1分以上、現在の予定(${box.planned_minutes}分)より短くしてください`)
  }
  const date = input.date !== undefined ? input.date : addDays(box.date, 1)
  const start = input.window_start !== undefined ? input.window_start : box.window_start
  const end = input.window_end !== undefined ? input.window_end : box.window_end
  validateBox(date, start, end, minutes)

  const settings = await loadSettings(p.userId)
  const preset = presetForWindow(settings, start as number, end as number)?.key ?? "custom"
  const created = await requireTable(() => db.insert("myflow_timeboxes", {
    id: newId("tb_"), user_id: p.userId, mode: box.mode, task_id: box.task_id,
    date, window_start: start, window_end: end, preset, planned_minutes: minutes, status: "planned",
  })) as TimeboxDb
  const original = (await db.update("myflow_timeboxes", id, {
    planned_minutes: box.planned_minutes - (minutes as number), updated_at: new Date().toISOString(),
  })) as TimeboxDb
  await recordEvent(p, { type: "timebox_split", mode: box.mode, task_id: box.task_id, timebox_id: id, payload: { minutes, new_timebox: created.id, date } })
  return { original, created }
}
