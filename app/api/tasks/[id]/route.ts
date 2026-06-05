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
