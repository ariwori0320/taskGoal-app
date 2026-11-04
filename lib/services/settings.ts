import { db, isMissingTable } from "../db"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../settings"
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

/** 設定の保存。画面（UI）からのみ。AI には設定の変更を許さない。 */
export async function saveSettings(p: Principal, patch: Partial<Settings>): Promise<Settings> {
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
  return next
}
