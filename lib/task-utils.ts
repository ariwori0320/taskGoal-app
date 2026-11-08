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

// ---------- 親子（サブタスク・孫タスク）の階層 ----------

export interface TaskNode {
  /** 祖先の名前（ルート → 親の順）。自分自身は含まない。例: ["提案書", "資料づくり"] */
  path: string[]
  /** ルートを 0 とした深さ */
  depth: number
  /** いちばん上の親の id（自分がルートなら自分） */
  root_id: string
  /** 子を持たない = 実際に予定に入れて作業する単位 */
  is_leaf: boolean
  /** 直接の子の数と、そのうちの完了数 */
  children_total: number
  children_done: number
  /** 子孫の「葉」の数と完了数。親の進み具合はこれで見る（自分が葉なら自分1件） */
  leaves_total: number
  leaves_done: number
}

/**
 * 全タスクから、各タスクの階層情報を作る。親の完了は子と独立なので、進み具合は「葉」で数える。
 * 親が一覧に無い（別カテゴリなど）場合は、見えている範囲でルート扱いにする。循環があっても止まる。
 */
export function buildHierarchy(all: TaskRow[], today: string): Map<string, TaskNode> {
  const byId = new Map(all.map(t => [t.id, t]))
  const kids = new Map<string, TaskRow[]>()
  for (const t of all) {
    if (t.parent_id && byId.has(t.parent_id)) {
      const a = kids.get(t.parent_id)
      if (a) a.push(t); else kids.set(t.parent_id, [t])
    }
  }
  const out = new Map<string, TaskNode>()
  const leafCounts = (t: TaskRow, seen: Set<string>): { total: number; done: number } => {
    if (seen.has(t.id)) return { total: 0, done: 0 }
    seen.add(t.id)
    const cs = kids.get(t.id) ?? []
    if (cs.length === 0) return { total: 1, done: isTaskDone(t, today) ? 1 : 0 }
    return cs.reduce((a, c) => { const r = leafCounts(c, seen); return { total: a.total + r.total, done: a.done + r.done } }, { total: 0, done: 0 })
  }
  for (const t of all) {
    const path: string[] = []
    let cur: TaskRow = t
    let root = t.id
    const seen = new Set([t.id])
    while (cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.parent_id)) {
      cur = byId.get(cur.parent_id)!
      seen.add(cur.id)
      path.unshift(cur.text)
      root = cur.id
    }
    const cs = kids.get(t.id) ?? []
    const leaves = leafCounts(t, new Set())
    out.set(t.id, {
      path, depth: path.length, root_id: root, is_leaf: cs.length === 0,
      children_total: cs.length, children_done: cs.filter(c => isTaskDone(c, today)).length,
      leaves_total: leaves.total, leaves_done: leaves.done,
    })
  }
  return out
}
