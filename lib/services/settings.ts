import { db, isMissingTable } from "../db"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../settings"
import { todayIn } from "../time"
import { recordEvent } from "../events"
import type { TimeboxDb } from "../types"
import { forbidden, migrationRequired, requireScope, USER_ID, type Principal } from "../principal"

/** 設定を読む。テーブル未作成・未保存なら既定値（プリセット: 朝/昼/夜、Asia/Tokyo）。 */
export async function loadSettings(userId: string = USER_ID): Promise<Settings> {
  try {
    const rows = await db.find("myflow_settings", [["user_id", "eq", userId]], { limit: 1 })
    const r = rows[0]
    if (!r) return { ...DEFAULT_SETTINGS, presets: DEFAULT_SETTINGS.presets.map(p => ({ ...p })) }
    return normalizeSettings({ timezone: r.timezone, presets: r.presets, bufferMinutes: r.buffer_minutes })
  } catch (e) {
    if (isMissingTable(e)) return { ...DEFAULT_SETTINGS, presets: DEFAULT_SETTINGS.presets.map(p => ({ ...p })) }
    throw e
  }
}

export interface Carryover { moved: number; skipped: number }

/**
 * 時間帯プリセット（朝/昼/夜）の開始・終了を変えたとき、今日以降の「未実施」の予定を新しい時間帯へ追従させる。
 * 予定は作成時の窓を持つため、そのままだと新しい設定のどれにも一致せず「その他」に移ってしまう。
 * 作業時間が新しい時間帯より長い予定は動かさない（skipped として知らせる）。過去・完了・解除済み・カスタムの窓は対象外。
 */
async function carryOverPresets(p: Principal, before: Settings, after: Settings): Promise<Carryover> {
  const result: Carryover = { moved: 0, skipped: 0 }
  const changed = before.presets.filter(o => {
    const n = after.presets.find(x => x.key === o.key)
    return n && (n.start !== o.start || n.end !== o.end)
  })
  if (changed.length === 0) return result
  const today = todayIn(after.timezone)
  let rows: TimeboxDb[]
  try {
    rows = await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["status", "eq", "planned"], ["date", "gte", today]]) as TimeboxDb[]
  } catch (e) {
    if (isMissingTable(e)) return result
    throw e
  }
  // 先に全員分の移動先を決めてから書き込む（別プリセットの窓を取り合わないよう、元の窓だけで判定）
  const plan: { box: TimeboxDb; start: number; end: number; key: string }[] = []
  for (const box of rows) {
    const old = changed.find(o => o.start === box.window_start && o.end === box.window_end)
    if (!old) continue
    const n = after.presets.find(x => x.key === old.key)!
    if (box.planned_minutes > n.end - n.start) { result.skipped++; continue }
    plan.push({ box, start: n.start, end: n.end, key: n.key })
  }
  const now = new Date().toISOString()
  for (const x of plan) {
    await db.updateWhere("myflow_timeboxes", [["id", "eq", x.box.id], ["user_id", "eq", p.userId]], { window_start: x.start, window_end: x.end, preset: x.key, updated_at: now })
    await recordEvent(p, { type: "timebox_moved", mode: x.box.mode, task_id: x.box.task_id, timebox_id: x.box.id, payload: { reason: "preset_changed", from: { date: x.box.date, window: [x.box.window_start, x.box.window_end] }, to: { date: x.box.date, window: [x.start, x.end] } } })
    result.moved++
  }
  return result
}

/** 設定の保存。画面（UI）からのみ。AI には設定の変更を許さない。 */
export async function saveSettings(p: Principal, patch: Partial<Settings>): Promise<Settings & { carryover: Carryover }> {
  if (p.kind !== "ui") throw forbidden("設定の変更はアプリの画面からのみ行えます")
  requireScope(p, "schedule")
  const current = await loadSettings(p.userId)
  const next = normalizeSettings({ ...current, ...patch })
  const row = {
    timezone: next.timezone,
    presets: next.presets,
    buffer_minutes: next.bufferMinutes,
    updated_at: new Date().toISOString(),
  }
  try {
    const existing = await db.find("myflow_settings", [["user_id", "eq", p.userId]], { limit: 1 })
    if (existing[0]) await db.updateWhere("myflow_settings", [["user_id", "eq", p.userId]], row)
    else await db.insert("myflow_settings", { user_id: p.userId, ...row })
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
  const carryover = await carryOverPresets(p, current, next)
  return { ...next, carryover }
}
