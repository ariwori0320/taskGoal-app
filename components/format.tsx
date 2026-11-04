import type { ReactNode } from "react"
import { windowLabel, type Settings } from "@/lib/settings"
import { diffDays, fmtDuration, minutesToHhmm } from "@/lib/time"

/** 「今日 / 明日 / 3日後 / 2日超過」 */
export function relDay(date: string | null, today: string): string {
  if (!date) return ""
  const d = diffDays(today, date)
  if (d === 0) return "今日"
  if (d === 1) return "明日"
  if (d < 0) return `${-d}日超過`
  return `${d}日後`
}

/** 「19:00–22:00」。時間帯の名前（朝・昼・夜）があれば先頭に付ける。 */
export function windowText(settings: Settings, start: number, end: number, withName = true): string {
  const span = `${minutesToHhmm(start)}–${minutesToHhmm(end)}`
  const name = windowLabel(settings, start, end)
  return withName && name ? `${name} ${span}` : span
}

export function slotName(settings: Settings, start: number, end: number): string {
  return windowLabel(settings, start, end) ?? "指定"
}

export { fmtDuration }

/** メモ中の URL をリンクにする（別タブで開く） */
export function renderWithLinks(text: string | null | undefined): ReactNode {
  if (!text) return null
  return text.split(/(https?:\/\/[^\s]+)/g).map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ wordBreak: "break-all" }}>{p}</a>
      : <span key={i}>{p}</span>
  )
}

export function parseTags(s: string | null | undefined): string[] {
  if (!s) return []
  return s.split(",").map(t => t.trim()).filter(Boolean)
}

export const PRIORITY_LABEL = { high: "高", mid: "中", low: "低" } as const
export const MODE_LABEL = { work: "仕事", private: "プライベート" } as const
