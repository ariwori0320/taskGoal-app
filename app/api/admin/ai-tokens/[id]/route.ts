import { adminRespond } from "@/lib/admin-http"
import { readBody } from "@/lib/http"
import { revokeToken, updateToken } from "@/lib/services/ai-tokens"

export const dynamic = "force-dynamic"

// 権限・カテゴリ・名前の変更（再発行は不要）
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return adminRespond(req, async () => updateToken(params.id, await readBody(req)))
}

// 取り消し（その場で使えなくなる。履歴は残る）
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return adminRespond(req, async () => revokeToken(params.id))
}
