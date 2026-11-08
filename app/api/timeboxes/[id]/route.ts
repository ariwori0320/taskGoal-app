import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { releaseTimebox, updateTimebox } from "@/lib/services/timeboxes"

// 移動・時間帯の変更・所要時間の変更
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => updateTimebox(UI_PRINCIPAL, params.id, await readBody(req)))
}

// 未配置に戻す（この予定を外す）
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return respond(async () => releaseTimebox(UI_PRINCIPAL, params.id))
}
