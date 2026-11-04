// 履歴・集計（完了履歴 / 先送り状況 / 週次・月次の集計）。読み取り専用。

import { db, isMissingTable, type Cond } from "../db"
import { requireScope, resolveModes, badRequest, type Mode, type Principal } from "../principal"
import { addDays, diffDays, isYmd, localDayStartUtc, nowInTz, parseYmd, weekStart } from "../time"
import type { EventRow, TaskRow, TimeboxDb } from "../types"
import { loadSettings } from "./settings"
import { isTaskDone } from "./tasks"

const MAX_RANGE_DAYS = 366

function checkRange(from: unknown, to: unknown) {
  if (!isYmd(from) || !isYmd(to)) throw badRequest("from / to は YYYY-MM-DD 形式で指定してください")
  if (from > to) throw badRequest("from は to 以前の日付にしてください")
  if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`集計できるのは${MAX_RANGE_DAYS}日までです`)
}

async function fetchEvents(p: Principal, modes: Mode[], from: string, to: string, types: string[], tz: string): Promise<EventRow[]> {
  if (modes.length === 0) return []
  const conds: Cond[] = [
    ["user_id", "eq", p.userId], ["mode", "in", modes], ["type", "in", types],
    ["created_at", "gte", localDayStartUtc(from, tz).toISOString()],
    ["created_at", "lt", localDayStartUtc(addDays(to, 1), tz).toISOString()],
  ]
  try {
    return (await db.find("myflow_events", conds, { order: "created_at.desc", limit: 2000 })) as EventRow[]
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
}

async function taskTexts(p: Principal, modes: Mode[], ids: string[]): Promise<Map<string, TaskRow>> {
  const map = new Map<string, TaskRow>()
  if (ids.length === 0 || modes.length === 0) return map
  const rows = (await db.find("tasks", [["user_id", "eq", p.userId], ["id", "in", ids], ["mode", "in", modes]], { limit: 2000 })) as TaskRow[]
  for (const r of rows) map.set(r.id, r)
  return map
}

async function historyStartsAt(p: Principal): Promise<string | null> {
  try {
    const rows = await db.find("myflow_events", [["user_id", "eq", p.userId]], { order: "created_at.asc", limit: 1 })
    return rows[0]?.created_at ?? null
  } catch (e) {
    if (isMissingTable(e)) return null
    throw e
  }
}

export async function completionHistory(p: Principal, q: { mode?: string | null; from: string; to: string }) {
  requireScope(p, "read")
  checkRange(q.from, q.to)
  const modes = resolveModes(p, q.mode)
  const settings = await loadSettings(p.userId)
  const events = await fetchEvents(p, modes, q.from, q.to, ["task_completed"], settings.timezone)
  const tasks = await taskTexts(p, modes, Array.from(new Set(events.map(e => e.task_id).filter((x): x is string => !!x))))
  return {
    from: q.from, to: q.to,
    history_starts_at: await historyStartsAt(p),
    completions: events.map(e => ({
      task_id: e.task_id, text: tasks.get(e.task_id ?? "")?.text ?? null, mode: e.mode, completed_at: e.created_at,
      kept_window: (e.payload as { kept_window?: boolean | null }).kept_window ?? null,
      had_timebox: (e.payload as { had_timebox?: boolean }).had_timebox ?? false,
    })),
  }
}

export async function postponements(p: Principal, q: { mode?: string | null; from: string; to: string }) {
  requireScope(p, "read")
  checkRange(q.from, q.to)
  const modes = resolveModes(p, q.mode)
  const settings = await loadSettings(p.userId)
  const events = await fetchEvents(p, modes, q.from, q.to, ["timebox_postponed"], settings.timezone)
  const byTask = new Map<string, { count: number; last_to: string | null }>()
  for (const e of events) {
    if (!e.task_id) continue
    const cur = byTask.get(e.task_id) ?? { count: 0, last_to: null }
    cur.count++
    const to = (e.payload as { to?: string }).to ?? null
    if (to && (!cur.last_to || to > cur.last_to)) cur.last_to = to
    byTask.set(e.task_id, cur)
  }
  const tasks = await taskTexts(p, modes, Array.from(byTask.keys()))
  const items = Array.from(byTask.entries())
    .map(([task_id, v]) => ({ task_id, text: tasks.get(task_id)?.text ?? null, postponed_count: v.count, latest_new_date: v.last_to }))
    .sort((a, b) => b.postponed_count - a.postponed_count)
  return { from: q.from, to: q.to, history_starts_at: await historyStartsAt(p), total_postponements: events.length, tasks: items }
}

export function periodRange(period: "week" | "month", date: string): { from: string; to: string } {
  if (period === "week") {
    const from = weekStart(date)
    return { from, to: addDays(from, 6) }
  }
  const ymd = parseYmd(date)!
  const from = `${String(ymd.y).padStart(4, "0")}-${String(ymd.m).padStart(2, "0")}-01`
  const nextMonth = ymd.m === 12 ? `${ymd.y + 1}-01-01` : `${ymd.y}-${String(ymd.m + 1).padStart(2, "0")}-01`
  return { from, to: addDays(nextMonth, -1) }
}

export async function summary(p: Principal, q: { mode?: string | null; period?: "week" | "month"; date?: string }) {
  requireScope(p, "read")
  const period = q.period ?? "week"
  if (period !== "week" && period !== "month") throw badRequest("period は week か month を指定してください")
  const settings = await loadSettings(p.userId)
  const now = nowInTz(settings.timezone)
  const date = q.date ?? now.date
  if (!isYmd(date)) throw badRequest("date は YYYY-MM-DD 形式で指定してください")
  const { from, to } = periodRange(period, date)
  const modes = resolveModes(p, q.mode)

  const empty = {
    period, from, to, modes,
    tasks: { due_in_period: 0, done_among_due: 0, completion_rate_percent: null as number | null, created_in_period: 0, overdue_now: 0 },
    activity: { completed_events: 0, completed_within_planned_window: 0 },
    timeboxes: { planned_count: 0, planned_minutes: 0, done_count: 0, kept_window_count: 0, released_count: 0 },
    postponements: { total: 0, most_postponed: [] as { text: string | null; count: number }[] },
    history_starts_at: await historyStartsAt(p),
    note: "完了履歴・先送り・時間帯の遵守は、リニューアル後に記録され始めた分のみ集計されます。",
  }
  if (modes.length === 0) return empty

  const tasks = (await db.find("tasks", [["user_id", "eq", p.userId], ["mode", "in", modes]], { limit: 2000 })) as TaskRow[]
  const dueIn = tasks.filter(t => t.due_date && t.due_date >= from && t.due_date <= to && !t.is_recurring)
  const doneAmong = dueIn.filter(t => isTaskDone(t, now.date))
  const fromUtc = localDayStartUtc(from, settings.timezone).getTime()
  const toUtc = localDayStartUtc(addDays(to, 1), settings.timezone).getTime()
  const created = tasks.filter(t => { const c = Date.parse(t.created_at); return c >= fromUtc && c < toUtc })
  const overdue = tasks.filter(t => !t.is_recurring && !isTaskDone(t, now.date) && t.due_date && t.due_date < now.date)

  const events = await fetchEvents(p, modes, from, to, ["task_completed", "timebox_postponed"], settings.timezone)
  const completed = events.filter(e => e.type === "task_completed")
  const postponed = events.filter(e => e.type === "timebox_postponed")

  let boxes: TimeboxDb[] = []
  try {
    boxes = (await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["mode", "in", modes], ["date", "gte", from], ["date", "lte", to]], { limit: 2000 })) as TimeboxDb[]
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }

  const counts = new Map<string, number>()
  for (const e of postponed) if (e.task_id) counts.set(e.task_id, (counts.get(e.task_id) ?? 0) + 1)
  const texts = await taskTexts(p, modes, Array.from(counts.keys()))
  const most = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, count]) => ({ text: texts.get(id)?.text ?? null, count }))

  return {
    ...empty,
    tasks: {
      due_in_period: dueIn.length,
      done_among_due: doneAmong.length,
      completion_rate_percent: dueIn.length === 0 ? null : Math.round((doneAmong.length / dueIn.length) * 100),
      created_in_period: created.length,
      overdue_now: overdue.length,
    },
    activity: {
      completed_events: completed.length,
      completed_within_planned_window: completed.filter(e => (e.payload as { kept_window?: boolean }).kept_window === true).length,
    },
    timeboxes: {
      planned_count: boxes.filter(b => b.status === "planned").length,
      planned_minutes: boxes.filter(b => b.status === "planned").reduce((s, b) => s + b.planned_minutes, 0),
      done_count: boxes.filter(b => b.status === "done").length,
      kept_window_count: boxes.filter(b => b.kept_window === true).length,
      released_count: boxes.filter(b => b.status === "released").length,
    },
    postponements: { total: postponed.length, most_postponed: most },
  }
}
