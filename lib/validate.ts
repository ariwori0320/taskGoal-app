// 入力検証（サービス層で共通利用）。「未指定(undefined)」と「クリア(null/空文字)」を区別する。

import { badRequest } from "./principal"
import { isYmd } from "./time"
import type { Priority } from "./types"

export function cleanText(v: unknown, label: string, max = 300): string {
  const s = typeof v === "string" ? v.trim() : ""
  if (!s) throw badRequest(`${label}は必須です`)
  if (s.length > max) throw badRequest(`${label}は${max}文字以内にしてください`)
  return s
}

/** undefined=未指定 / null・""=クリア / "YYYY-MM-DD"=設定 */
export function optYmd(v: unknown, label: string): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === "") return null
  if (!isYmd(v)) throw badRequest(`${label}は YYYY-MM-DD 形式で指定してください`)
  return v
}

export function optEstimate(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === "") return null
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1440) {
    throw badRequest("所要時間は1〜1440分の整数で指定してください")
  }
  return v as number
}

export function optPriority(v: unknown): Priority | undefined {
  if (v === undefined) return undefined
  if (v === "high" || v === "mid" || v === "low") return v
  throw badRequest("優先度は high / mid / low のいずれかです")
}

/** 繰り返し曜日: "1,3,5" 形式に正規化（空文字=毎日）。不正な値は 400。 */
export function normDays(v: unknown): string {
  if (v === undefined || v === null || v === "") return ""
  if (typeof v !== "string") throw badRequest("繰り返し曜日の形式が不正です")
  const parts = v.split(",").map(s => s.trim()).filter(s => s !== "")
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw badRequest("繰り返し曜日は 0(日)〜6(土) で指定してください")
  return Array.from(new Set(nums)).sort((a, b) => a - b).join(",")
}

export function optBool(v: unknown, label: string): boolean | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "boolean") throw badRequest(`${label}は true / false で指定してください`)
  return v
}

export function optString(v: unknown, label: string, max = 5000): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "string") throw badRequest(`${label}は文字列で指定してください`)
  if (v.length > max) throw badRequest(`${label}は${max}文字以内にしてください`)
  return v
}
