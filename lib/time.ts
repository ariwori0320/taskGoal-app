// 日付・時刻のユーティリティ（純粋関数）。
// 日付は "YYYY-MM-DD" 文字列、時刻は「0時からの分」(0〜1440) で扱う。
// 日付の加減算は UTC の暦計算で行うため、サマータイムやブラウザのタイムゾーンに左右されない。

export const DEFAULT_TZ = "Asia/Tokyo"

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
export const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"]

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 指定タイムゾーンでの「いま」(日付・0時からの分・曜日) */
export function nowInTz(tz: string = DEFAULT_TZ, now: Date = new Date()) {
  const zone = isValidTz(tz) ? tz : DEFAULT_TZ
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ""
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  }
}

export function todayIn(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return nowInTz(tz, now).date
}

/** 指定タイムゾーンの、その瞬間のUTCとの差（分）。JST なら +540 */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** 現地の日付の 0:00 にあたる瞬間(UTC)。履歴を「現地の日」で区切って検索するのに使う。 */
export function localDayStartUtc(date: string, tz: string = DEFAULT_TZ): Date {
  const p = parseYmd(date)
  if (!p) throw new Error(`invalid date: ${date}`)
  const zone = isValidTz(tz) ? tz : DEFAULT_TZ
  const guess = Date.UTC(p.y, p.m - 1, p.d)
  let t = guess - tzOffsetMinutes(new Date(guess), zone) * 60000
  t = guess - tzOffsetMinutes(new Date(t), zone) * 60000 // 夏時間の境目向けにもう一度補正
  return new Date(t)
}

// ---- 日付文字列 ----

export function parseYmd(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!mt) return null
  const y = Number(mt[1]), m = Number(mt[2]), d = Number(mt[3])
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return { y, m, d }
}

export function isYmd(s: unknown): s is string {
  return parseYmd(s) !== null
}

function ymdFromUtc(dt: Date): string {
  const y = String(dt.getUTCFullYear()).padStart(4, "0")
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0")
  const d = String(dt.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function addDays(date: string, n: number): string {
  const p = parseYmd(date)
  if (!p) throw new Error(`invalid date: ${date}`)
  return ymdFromUtc(new Date(Date.UTC(p.y, p.m - 1, p.d + n)))
}

export function dowOf(date: string): number {
  const p = parseYmd(date)
  if (!p) throw new Error(`invalid date: ${date}`)
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
}

export function diffDays(from: string, to: string): number {
  const a = parseYmd(from), b = parseYmd(to)
  if (!a || !b) throw new Error("invalid date")
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000)
}

/** その日を含む週の開始日（既定は月曜始まり） */
export function weekStart(date: string, weekStartsOn: number = 1): string {
  const offset = (dowOf(date) - weekStartsOn + 7) % 7
  return addDays(date, -offset)
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  const n = diffDays(from, to)
  for (let i = 0; i <= n && i < 400; i++) out.push(addDays(from, i))
  return out
}

/** 「11/5(木)」形式 */
export function fmtMdDow(date: string): string {
  const p = parseYmd(date)
  if (!p) return date
  return `${p.m}/${p.d}(${DAY_LABELS[dowOf(date)]})`
}

// ---- 分(0時からの経過) ----

export const MINUTES_PER_DAY = 1440

export function hhmmToMinutes(s: unknown): number | null {
  if (typeof s !== "string") return null
  const mt = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!mt) return null
  const h = Number(mt[1]), m = Number(mt[2])
  if (m > 59) return null
  const total = h * 60 + m
  if (total > MINUTES_PER_DAY) return null
  return total
}

export function minutesToHhmm(min: number): string {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

/** 90 → "1時間30分", 30 → "30分", 120 → "2時間" */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}分`
  const h = Math.floor(m / 60), r = m % 60
  return r === 0 ? `${h}時間` : `${h}時間${r}分`
}

export function isValidWindow(start: unknown, end: unknown): boolean {
  return Number.isInteger(start) && Number.isInteger(end) &&
    (start as number) >= 0 && (end as number) <= MINUTES_PER_DAY && (start as number) < (end as number)
}

export function isValidPlannedMinutes(n: unknown): boolean {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MINUTES_PER_DAY
}
