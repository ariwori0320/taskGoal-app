// 画面用: 取得した週/日のデータから、時間帯の空きと負荷を計算する（計算式はサーバーと共通の lib/planning.ts）

import { computeWindowLoad, type FixedOccurrence, type TimeboxRow } from "@/lib/planning"
import type { Mode, Schedule } from "./store"

/** その日の「固定予定」と「タイムボックス」を、全カテゴリ分そろえる（別カテゴリは時間だけ・名前なし） */
export function dayContext(sched: Schedule, mode: Mode, date: string): { fixed: FixedOccurrence[]; boxes: TimeboxRow[] } {
  const other: Mode = mode === "work" ? "private" : "work"
  const fixed: FixedOccurrence[] = [
    ...sched.fixedEvents.filter(f => f.date === date),
    ...(sched.otherBusy ?? []).filter(b => b.date === date && b.kind === "fixed").map((b, i) => ({
      event_id: `other-${i}`, mode: other, title: "", date, start_min: b.start, end_min: b.end, allows_tasks: !!b.allows_tasks,
    })),
  ]
  const boxes: TimeboxRow[] = [
    ...sched.timeboxes.filter(b => b.date === date),
    ...(sched.otherBusy ?? []).filter(b => b.date === date && b.kind === "planned").map((b, i) => ({
      id: `other-${i}`, mode: other, task_id: "", date, window_start: b.start, window_end: b.end, planned_minutes: b.minutes ?? 0, status: "planned",
    })),
  ]
  return { fixed, boxes }
}

export function slotLoad(sched: Schedule, mode: Mode, date: string, start: number, end: number, excludeId?: string) {
  const { fixed, boxes } = dayContext(sched, mode, date)
  const r = computeWindowLoad({ window: { start, end }, mode, fixed, timeboxes: boxes, bufferMinutes: sched.settings.bufferMinutes, excludeId })
  return { free: r.free, used: r.own + r.other, remain: r.remain, blocked: r.free === 0 }
}
