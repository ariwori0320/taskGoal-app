// ユーザー設定（時間帯プリセット・タイムゾーン・余白）。DB が無くても既定値で動く。

import { DEFAULT_TZ, isValidTz, isValidWindow } from "./time"

export type PresetKey = "morning" | "noon" | "night"

export interface Preset {
  key: PresetKey
  label: string
  start: number // 0時からの分
  end: number
}

export interface Settings {
  timezone: string
  presets: Preset[]
  /** 1件のタイムボックスごとに上乗せする移動・休憩の余白（分） */
  bufferMinutes: number
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: DEFAULT_TZ,
  presets: [
    { key: "morning", label: "朝", start: 6 * 60, end: 10 * 60 },
    { key: "noon", label: "昼", start: 12 * 60, end: 17 * 60 },
    { key: "night", label: "夜", start: 19 * 60, end: 22 * 60 },
  ],
  bufferMinutes: 5,
}

const PRESET_KEYS: PresetKey[] = ["morning", "noon", "night"]

/** 不正な値は既定値に置き換えて、常に有効な Settings を返す */
export function normalizeSettings(input: unknown): Settings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const timezone = isValidTz(src.timezone) ? (src.timezone as string) : DEFAULT_SETTINGS.timezone

  const given = Array.isArray(src.presets) ? (src.presets as Record<string, unknown>[]) : []
  const presets: Preset[] = PRESET_KEYS.map(key => {
    const def = DEFAULT_SETTINGS.presets.find(p => p.key === key)!
    const g = given.find(p => p && p.key === key)
    if (g && isValidWindow(g.start, g.end)) {
      const label = typeof g.label === "string" && g.label.trim() ? g.label.trim().slice(0, 8) : def.label
      return { key, label, start: g.start as number, end: g.end as number }
    }
    return { ...def }
  })

  const b = src.bufferMinutes
  const bufferMinutes = Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 120 ? (b as number) : DEFAULT_SETTINGS.bufferMinutes

  return { timezone, presets, bufferMinutes }
}

export function presetForWindow(settings: Settings, start: number, end: number): Preset | null {
  return settings.presets.find(p => p.start === start && p.end === end) ?? null
}

export function windowLabel(settings: Settings, start: number, end: number): string | null {
  return presetForWindow(settings, start, end)?.label ?? null
}
