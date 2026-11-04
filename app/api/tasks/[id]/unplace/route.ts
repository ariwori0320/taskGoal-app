import { respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { unplaceTask } from "@/lib/services/timeboxes"

// タスクの予定をすべて外して「未配置」に戻す
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  return respond(async () => unplaceTask(UI_PRINCIPAL, params.id))
}
