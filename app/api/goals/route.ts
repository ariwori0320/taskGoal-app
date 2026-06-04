import { NextResponse } from "next/server"
import { db } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "work"
    const data = await db.select("goals", { user_id: USER_ID, mode })
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
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
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
