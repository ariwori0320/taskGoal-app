// タスクに関する純粋関数（画面・サーバー共通。DBや認証に依存しない）

import { addDays, dowOf, fmtMdDow, DAY_LABELS } from "./time"
import { parseDays } from "./planning"
import type { TaskRow } from "./types"

type DoneFields = Pick<TaskRow, "is_recurring" | "recurring_done_date" | "done">

/** その日(today)の時点で完了しているか。繰り返しタスクは「今日の分」を完了したかどうか。 */
export function isTaskDone(t: DoneFields, today: string): boolean {
  return t.is_recurring ? t.recurring_done_date === today : !!t.done
}

/** 繰り返しタスクが、その日に該当するか（recurring_days が空なら毎日） */
export function recursOn(t: Pick<TaskRow, "is_recurring" | "recurring_days">, date: string): boolean {
  if (!t.is_recurring) return false
  const days = parseDays(t.recurring_days)
  return days.length === 0 || days.includes(dowOf(date))
}

/** 次に該当する日（今日の分を完了済みなら明日以降から探す） */
export function nextRecurrenceDate(t: Pick<TaskRow, "is_recurring" | "recurring_days" | "recurring_done_date">, today: string): string {
  const doneToday = t.recurring_done_date === today
  for (let i = doneToday ? 1 : 0; i < 21; i++) {
    const d = addDays(today, i)
    if (recursOn({ is_recurring: true, recurring_days: t.recurring_days }, d)) return d
  }
  return today
}

export function recurrenceLabel(t: Pick<TaskRow, "recurring_days">): string {
  const days = parseDays(t.recurring_days)
  if (days.length === 0) return "毎日"
  // 月曜始まりで並べる
  return [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => DAY_LABELS[d]).join("・")
}

export function nextRecurrenceText(t: Pick<TaskRow, "is_recurring" | "recurring_days" | "recurring_done_date">, today: string): string {
  const d = nextRecurrenceDate(t, today)
  if (d === today) return "今日"
  if (d === addDays(today, 1)) return "明日"
  return fmtMdDow(d)
}

// ---------- 並び順 ----------

const PRANK: Record<string, number> = { high: 0, mid: 1, low: 2 }

/** 繰り返しタスクを常に最上部へ */
export function recurringFirst(a: Pick<TaskRow, "is_recurring">, b: Pick<TaskRow, "is_recurring">): number {
  if (a.is_recurring && !b.is_recurring) return -1
  if (!a.is_recurring && b.is_recurring) return 1
  return 0
}

/** 自動: 繰り返し → 期限あり(早い順) → 優先度の高い順 */
export function autoCompare(a: TaskRow, b: TaskRow): number {
  const rec = recurringFirst(a, b)
  if (rec !== 0) return rec
  const ad = a.is_recurring ? null : a.due_date
  const bd = b.is_recurring ? null : b.due_date
  if (ad && !bd) return -1
  if (!ad && bd) return 1
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1
  return (PRANK[a.priority] ?? 1) - (PRANK[b.priority] ?? 1)
}

/** 手動: 繰り返し → sort_order 順（未設定は後ろ） */
export function manualCompare(a: TaskRow, b: TaskRow): number {
  const rec = recurringFirst(a, b)
  if (rec !== 0) return rec
  return (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)
}

/** 期間(開始〜終了)に重なるか。繰り返しは常に対象。 */
export function inDateRange(t: TaskRow, from: string, to: string): boolean {
  if (!from && !to) return true
  if (t.is_recurring) return true
  const s = t.start_date || t.due_date
  const e = t.due_date || t.start_date
  if (!s || !e) return false
  if (from && e < from) return false
  if (to && s > to) return false
  return true
}
