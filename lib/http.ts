import { NextResponse } from "next/server"
import { ServiceError } from "./principal"

/** JSON ボディを読む。壊れていれば 400。 */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json()
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
  } catch {
    throw new ServiceError(400, "bad_request", "リクエストの JSON を読み取れませんでした")
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  // 内部エラー（DB のエラー文など）は利用者へ出さず、サーバーログにだけ残す
  console.error("[api]", e instanceof Error ? e.message.slice(0, 500) : e)
  return NextResponse.json({ error: "サーバーでエラーが発生しました", code: "server_error" }, { status: 500 })
}

export async function respond<T>(fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { status })
  } catch (e) {
    return errorResponse(e)
  }
}
