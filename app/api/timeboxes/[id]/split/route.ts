import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { splitTimebox } from "@/lib/services/timeboxes"

// 予定の一部を別の日・時間帯へ分ける
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => splitTimebox(UI_PRINCIPAL, params.id, await readBody(req)), 201)
}
