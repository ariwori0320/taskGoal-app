// 計画ロジック（純粋関数）。DB・フレームワークに依存しない。
// 区間はすべて「その日の0時からの分」。

import { dowOf, eachDay, fmtDuration, minutesToHhmm } from "./time"

export type Interval = { start: number; end: number }

// ---------- 区間演算 ----------

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(i => i.end > i.start).map(i => ({ ...i })).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push(i)
  }
  return out
}

export function totalLength(list: Interval[]): number {
  return mergeIntervals(list).reduce((sum, i) => sum + (i.end - i.start), 0)
}

/** base から cuts を取り除いた残りの区間 */
export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  const c = mergeIntervals(cuts)
  const out: Interval[] = []
  for (const b of mergeIntervals(base)) {
    let cursor = b.start
    for (const cut of c) {
      if (cut.end <= cursor) continue
      if (cut.start >= b.end) break
      if (cut.start > cursor) out.push({ start: cursor, end: cut.start })
      cursor = Math.max(cursor, cut.end)
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end })
  }
  return out
}

export function overlapLength(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

// ---------- 固定予定 ----------

export interface FixedEventRow {
  id: string
  mode: string
  title: string
  date: string | null          // 単発: その日 / 繰り返し: 開始日(null=ずっと前から)
  start_min: number
  end_min: number
  repeat_days: string          // "" = 単発 / "1,2,3,4,5" = 曜日指定の繰り返し (0=日..6=土)
  until?: string | null        // 繰り返しの終了日
}

export interface FixedOccurrence {
  event_id: string
  mode: string
  title: string
  date: string
  start_min: number
  end_min: number
}

export function parseDays(csv: string | null | undefined): number[] {
  if (!csv) return []
  return csv.split(",").map(s => s.trim()).filter(s => s !== "").map(Number)
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
}

export function occursOn(ev: FixedEventRow, date: string): boolean {
  const days = parseDays(ev.repeat_days)
  if (days.length === 0) return ev.date === date
  if (ev.date && date < ev.date) return false
  if (ev.until && date > ev.until) return false
  return days.includes(dowOf(date))
}

export function expandFixedEvents(events: FixedEventRow[], from: string, to: string): FixedOccurrence[] {
  const out: FixedOccurrence[] = []
  for (const date of eachDay(from, to)) {
    for (const ev of events) {
      if (!occursOn(ev, date)) continue
      out.push({ event_id: ev.id, mode: ev.mode, title: ev.title, date, start_min: ev.start_min, end_min: ev.end_min })
    }
  }
  return out
}

// ---------- タイムボックスと余白 ----------

export interface TimeboxRow {
  id: string
  mode: string
  task_id: string
  date: string
  window_start: number
  window_end: number
  planned_minutes: number
  status: string               // planned | done | released
  preset?: string | null
  actual_minutes?: number | null
}

export interface PlanWarning {
  code: "window_over" | "window_blocked" | "day_over" | "fixed_overlap"
  /** 別カテゴリの予定が関わっているか（別カテゴリの詳細は含めない） */
  crossCategory: boolean
  date: string
  window?: Interval
  freeMinutes?: number
  demandMinutes?: number
  overMinutes?: number
  timeboxIds?: string[]
  /** 同じカテゴリ同士の重なりのときだけ入る */
  titles?: [string, string]
}

export interface WindowLoad {
  start: number
  end: number
  freeMinutes: number     // 時間帯から固定予定(全カテゴリ)を除いた空き
  ownMinutes: number      // このカテゴリの必要作業時間(余白込み)
  otherMinutes: number    // 別カテゴリが確実にこの時間帯へ入れる必要がある時間
  overMinutes: number
  timeboxIds: string[]
}

export interface DayAnalysis {
  date: string
  windows: WindowLoad[]
  freeMinutes: number     // このカテゴリの時間帯の和集合 − 固定予定
  plannedMinutes: number  // このカテゴリの予定作業時間の合計(余白を含まない)
  overMinutes: number
  warnings: PlanWarning[]
}

export interface AnalyzeInput {
  date: string
  currentMode: string
  /** その日の固定予定(全カテゴリ) */
  fixed: FixedOccurrence[]
  /** その日のタイムボックス(全カテゴリ。planned のみが計算対象) */
  timeboxes: TimeboxRow[]
  /** 1件ごとに上乗せする移動・休憩の余白(分) */
  bufferMinutes?: number
}

export function analyzeDay(input: AnalyzeInput): DayAnalysis {
  const { date, currentMode } = input
  const buffer = Math.max(0, input.bufferMinutes ?? 0)
  const active = input.timeboxes.filter(t => t.status === "planned")
  const own = active.filter(t => t.mode === currentMode)
  const others = active.filter(t => t.mode !== currentMode)
  const fixedBusy = mergeIntervals(input.fixed.map(f => ({ start: f.start_min, end: f.end_min })))
  const demand = (t: TimeboxRow) => t.planned_minutes + buffer
  const windowOf = (t: TimeboxRow): Interval => ({ start: t.window_start, end: t.window_end })

  // タイムボックス t の必要時間のうち、時間帯 W の中に必ず収めなければならない分。
  // t の時間帯のうち W の外にある空き時間で吸収できる分は「必ずしも W に入らない」とみなす。
  const forcedInto = (t: TimeboxRow, w: Interval): number => {
    if (overlapLength(windowOf(t), w) <= 0) return 0
    const outside = subtractIntervals(subtractIntervals([windowOf(t)], [w]), fixedBusy)
    return Math.max(0, demand(t) - totalLength(outside))
  }

  const warnings: PlanWarning[] = []
  const windows: WindowLoad[] = []

  // 同じ時間帯ごとにまとめて評価
  const seen = new Set<string>()
  for (const t of own) {
    const key = `${t.window_start}-${t.window_end}`
    if (seen.has(key)) continue
    seen.add(key)
    const w = windowOf(t)
    const free = totalLength(subtractIntervals([w], fixedBusy))
    const group = own.filter(o => o.window_start === t.window_start && o.window_end === t.window_end)
    const ownMinutes = own.reduce((s, o) => s + forcedInto(o, w), 0)
    const otherMinutes = others.reduce((s, o) => s + forcedInto(o, w), 0)
    const over = Math.max(0, ownMinutes + otherMinutes - free)
    windows.push({
      start: w.start, end: w.end, freeMinutes: free, ownMinutes, otherMinutes,
      overMinutes: over, timeboxIds: group.map(g => g.id),
    })
    if (free === 0) {
      warnings.push({ code: "window_blocked", crossCategory: false, date, window: w, freeMinutes: 0, demandMinutes: ownMinutes, overMinutes: ownMinutes, timeboxIds: group.map(g => g.id) })
    } else if (ownMinutes > free) {
      warnings.push({ code: "window_over", crossCategory: false, date, window: w, freeMinutes: free, demandMinutes: ownMinutes, overMinutes: ownMinutes - free, timeboxIds: group.map(g => g.id) })
    } else if (ownMinutes + otherMinutes > free) {
      warnings.push({ code: "window_over", crossCategory: true, date, window: w, freeMinutes: free, demandMinutes: ownMinutes + otherMinutes, overMinutes: ownMinutes + otherMinutes - free, timeboxIds: group.map(g => g.id) })
    }
  }

  // 1日の合計（時間帯の警告が無いときだけ補足として出す）
  const ownUnion = mergeIntervals(own.map(windowOf))
  const freeOwn = totalLength(subtractIntervals(ownUnion, fixedBusy))
  const demandOwn = own.reduce((s, t) => s + demand(t), 0)
  const plannedMinutes = own.reduce((s, t) => s + t.planned_minutes, 0)
  const dayOver = Math.max(0, demandOwn - freeOwn)
  if (own.length > 0 && warnings.length === 0) {
    const allUnion = mergeIntervals(active.map(windowOf))
    const freeAll = totalLength(subtractIntervals(allUnion, fixedBusy))
    const demandAll = active.reduce((s, t) => s + demand(t), 0)
    if (demandOwn > freeOwn) {
      warnings.push({ code: "day_over", crossCategory: false, date, freeMinutes: freeOwn, demandMinutes: demandOwn, overMinutes: demandOwn - freeOwn })
    } else if (demandAll > freeAll) {
      warnings.push({ code: "day_over", crossCategory: true, date, freeMinutes: freeAll, demandMinutes: demandAll, overMinutes: demandAll - freeAll })
    }
  }

  // 固定予定同士の重なり（このカテゴリが関わるものだけ）
  const fx = input.fixed
  for (let i = 0; i < fx.length; i++) {
    for (let j = i + 1; j < fx.length; j++) {
      const a = fx[i], b = fx[j]
      if (a.event_id === b.event_id) continue
      if (a.mode !== currentMode && b.mode !== currentMode) continue
      const ov = overlapLength({ start: a.start_min, end: a.end_min }, { start: b.start_min, end: b.end_min })
      if (ov <= 0) continue
      const cross = a.mode !== b.mode
      warnings.push({
        code: "fixed_overlap", crossCategory: cross, date,
        window: { start: Math.max(a.start_min, b.start_min), end: Math.min(a.end_min, b.end_min) },
        overMinutes: ov,
        ...(cross ? {} : { titles: [a.title, b.title] as [string, string] }),
      })
    }
  }

  return { date, windows, freeMinutes: freeOwn, plannedMinutes, overMinutes: dayOver, warnings }
}

/** 警告を日本語の文にする。別カテゴリの予定名は決して含めない。 */
export function describeWarning(w: PlanWarning, labelFor?: (start: number, end: number) => string | null): string {
  const span = w.window ? `${minutesToHhmm(w.window.start)}–${minutesToHhmm(w.window.end)}` : ""
  const name = w.window ? `${labelFor?.(w.window.start, w.window.end) ?? ""}${labelFor?.(w.window.start, w.window.end) ? " " : ""}${span}` : "この日"
  switch (w.code) {
    case "window_blocked":
      return `${name} は固定予定と重なっていて、作業時間が取れません`
    case "window_over":
      return w.crossCategory
        ? `${name} は別カテゴリの予定と合わせると${fmtDuration(w.overMinutes ?? 0)}足りません`
        : `${name} は予定が${fmtDuration(w.overMinutes ?? 0)}超過しています（空き${fmtDuration(w.freeMinutes ?? 0)}／予定${fmtDuration(w.demandMinutes ?? 0)}）`
    case "day_over":
      return w.crossCategory
        ? `この日は別カテゴリの予定と合わせると作業時間が${fmtDuration(w.overMinutes ?? 0)}足りません`
        : `この日は作業時間が${fmtDuration(w.overMinutes ?? 0)}足りません（空き${fmtDuration(w.freeMinutes ?? 0)}／予定${fmtDuration(w.demandMinutes ?? 0)}）`
    case "fixed_overlap":
      return w.crossCategory
        ? `別カテゴリの固定予定と ${span} で重なっています`
        : `固定予定「${w.titles?.[0] ?? ""}」と「${w.titles?.[1] ?? ""}」が ${span} で重なっています`
  }
}

// ---------- タスクの配置状況 ----------

export function taskPlanSummary(
  estimateMinutes: number | null | undefined,
  boxes: { status: string; planned_minutes: number; actual_minutes?: number | null }[]
) {
  const planned = boxes.filter(b => b.status === "planned").reduce((s, b) => s + b.planned_minutes, 0)
  const done = boxes.filter(b => b.status === "done").reduce((s, b) => s + (b.actual_minutes ?? b.planned_minutes), 0)
  const est = typeof estimateMinutes === "number" ? estimateMinutes : null
  return {
    plannedMinutes: planned,
    doneMinutes: done,
    // 見積りが無ければ null（未配置の残りは計算できない）
    unplacedMinutes: est === null ? null : Math.max(0, est - planned - done),
  }
}
