import { NextResponse } from "next/server"
import { db } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

// GET /api/highlights?mode=work  → { year, month }
export async function GET(req: Request) {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "work"
    const rows = await db.select("highlights", { user_id: USER_ID, mode })
    const row = Array.isArray(rows) ? rows[0] : null
    return NextResponse.json({
      year: row?.year_text || "",
      month: row?.month_text || "",
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// PATCH /api/highlights  body: { mode, year_text?, month_text? }
export async function PATCH(req: Request) {
  try {
    const body = await req.json()
    const mode = body.mode || "work"
    const rows = await db.select("highlights", { user_id: USER_ID, mode })
    const existing = Array.isArray(rows) ? rows[0] : null

    let row
    if (existing) {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof body.year_text === "string") updates.year_text = body.year_text
      if (typeof body.month_text === "string") updates.month_text = body.month_text
      row = await db.update("highlights", existing.id, updates)
    } else {
      row = await db.insert("highlights", {
        id: uid(), user_id: USER_ID, mode,
        year_text: body.year_text || "",
        month_text: body.month_text || "",
      })
    }
    return NextResponse.json({
      year: row?.year_text || "",
      month: row?.month_text || "",
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
