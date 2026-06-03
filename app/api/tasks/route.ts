import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") || "work"
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*")
    .eq("user_id", USER_ID)
    .eq("mode", mode)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const { text, priority, due_date, mode } = await req.json()
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 })

  const { data, error } = await getSupabase()
    .from("tasks")
    .insert({ id: uid(), user_id: USER_ID, mode, text: text.trim(), priority: priority || "mid", due_date: due_date || null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
