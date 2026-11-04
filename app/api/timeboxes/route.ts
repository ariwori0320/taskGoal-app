import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { createTimebox, listTimeboxes } from "@/lib/services/timeboxes"

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return respond(async () => {
    const sp = new URL(req.url).searchParams
    return listTimeboxes(UI_PRINCIPAL, {
      mode: sp.get("mode"),
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      task_id: sp.get("task_id") ?? undefined,
    })
  })
}

export async function POST(req: Request) {
  return respond(async () => createTimebox(UI_PRINCIPAL, await readBody(req)), 201)
}
