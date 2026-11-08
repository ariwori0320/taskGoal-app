import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { errorResponse } from "@/lib/http"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body.title === "string") updates.title = body.title
    if (typeof body.content === "string") updates.content = body.content
    if (typeof body.tags === "string") updates.tags = body.tags
    const memo = await db.update("memos", params.id, updates)
    return NextResponse.json(memo)
  } catch (e) {
    return errorResponse(e)
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    await db.delete("memos", params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return errorResponse(e)
  }
}
