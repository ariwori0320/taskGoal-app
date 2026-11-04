import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { completeTimebox } from "@/lib/services/timeboxes"

// 「今日はここまで」: この予定を実施済みにする。タスクは完了にしない。
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => {
    const body = await readBody(req)
    return completeTimebox(UI_PRINCIPAL, params.id, { actual_minutes: body.actual_minutes })
  })
}
