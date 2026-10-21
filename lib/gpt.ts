import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const USER_ID = "default"

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

// 定数時間比較（トークン総当たりのタイミング差を避ける）
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Bearer 認証。問題があれば Response を返し、OK なら null を返す。
 * GPT_API_KEY 未設定時は 503（フェイルクローズ: 誤って無防備に公開しない）。
 */
export function checkGptAuth(req: Request): NextResponse | null {
  const configured = process.env.GPT_API_KEY ?? ""
  if (!configured) {
    return NextResponse.json({ error: "GPT API is not configured (GPT_API_KEY 未設定)" }, { status: 503 })
  }
  const header = req.headers.get("authorization") || ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token || !safeEqual(token, configured)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  return null
}

// サーバー(UTC)でも日本時間の「今日」を YYYY-MM-DD で返す
export function tokyoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date())
}

export function isTaskDone(t: any, today: string): boolean {
  if (t.is_recurring) return t.recurring_done_date === today
  return !!t.done
}

export async function getTask(id: string): Promise<any | null> {
  const rows = await db.select("tasks", { user_id: USER_ID, id })
  return Array.isArray(rows) ? rows[0] ?? null : null
}

// GPT に返す際の整形（内部フィールドを絞り、completed を算出）
export function shapeTask(t: any, today: string) {
  return {
    id: t.id,
    text: t.text,
    mode: t.mode,
    priority: t.priority,
    completed: isTaskDone(t, today),
    start_date: t.start_date ?? null,
    due_date: t.due_date ?? null,
    is_recurring: !!t.is_recurring,
    recurring_days: t.recurring_days ?? "",
    parent_id: t.parent_id ?? null,
    memo: t.memo ?? null,
    created_at: t.created_at,
  }
}
