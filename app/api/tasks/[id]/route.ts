import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json()
    const updates: Record<string, unknown> = {}
    if (typeof body.done === "boolean") updates.done = body.done
    if (typeof body.text === "string") updates.text = body.text
    if (typeof body.memo === "string") updates.memo = body.memo
    if (typeof body.mode === "string") updates.mode = body.mode
    if (typeof body.priority === "string") updates.priority = body.priority
    if ("start_date" in body) updates.start_date = body.start_date || null
    if ("due_date" in body) updates.due_date = body.due_date || null
    if (typeof body.is_recurring === "boolean") updates.is_recurring = body.is_recurring
    if (typeof body.recurring_days === "string") updates.recurring_days = body.recurring_days
    if ("recurring_done_date" in body) updates.recurring_done_date = body.recurring_done_date
    if (typeof body.sort_order === "number") updates.sort_order = body.sort_order

    const task = await db.update("tasks", params.id, updates)
    return NextResponse.json(task)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    await db.delete("tasks", params.id)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
