import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { errorResponse } from "@/lib/http"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json()
    const updates: Record<string, unknown> = {}
    if (typeof body.pct === "number") updates.pct = body.pct
    if (typeof body.text === "string") updates.text = body.text
    if ("due_date" in body) updates.due_date = body.due_date || null
    const goal = await db.update("goals", params.id, updates)
    return NextResponse.json(goal)
  } catch (e) {
    return errorResponse(e)
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    await db.delete("goals", params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return errorResponse(e)
  }
}
