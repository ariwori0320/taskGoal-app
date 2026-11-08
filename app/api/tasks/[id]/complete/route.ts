import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { completeTask } from "@/lib/services/tasks"

// タスクの完了 / 未完了に戻す。予定(タイムボックス)の実施記録もここでまとめて更新する。
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => {
    const body = await readBody(req)
    return completeTask(UI_PRINCIPAL, params.id, body.done === false ? false : true)
  })
}
