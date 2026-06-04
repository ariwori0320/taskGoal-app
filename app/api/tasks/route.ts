import { NextResponse } from "next/server"
import { db } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "work"
    const data = await db.select("tasks", { user_id: USER_ID, mode })
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { text, priority, due_date, mode, parent_id } = await req.json()
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 })
    const task = await db.insert("tasks", {
      id: uid(), user_id: USER_ID, mode: mode || "work",
      text: text.trim(), priority: priority || "mid",
      due_date: due_date || null, parent_id: parent_id || null, done: false,
    })
    return NextResponse.json(task, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
