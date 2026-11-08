import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { errorResponse, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { listGoals } from "@/lib/services/goals"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

// 取得: 従来の項目に加えて、紐づくタスクの数と完了数（linked_total / linked_done）を返す
export async function GET(req: Request) {
  return respond(async () => listGoals(UI_PRINCIPAL, new URL(req.url).searchParams.get("mode") || "work"))
}

export async function POST(req: Request) {
  try {
    const { text, due_date, mode } = await req.json()
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 })
    const goal = await db.insert("goals", {
      id: uid(), user_id: USER_ID, mode: mode || "work",
      text: text.trim(), due_date: due_date || null, pct: 0,
    })
    return NextResponse.json(goal, { status: 201 })
  } catch (e) {
    return errorResponse(e)
  }
}
