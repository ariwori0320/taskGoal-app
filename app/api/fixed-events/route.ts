import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { createFixedEvent, listFixedEvents } from "@/lib/services/schedule"

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return respond(async () => listFixedEvents(UI_PRINCIPAL, new URL(req.url).searchParams.get("mode")))
}

export async function POST(req: Request) {
  return respond(async () => createFixedEvent(UI_PRINCIPAL, await readBody(req)), 201)
}
