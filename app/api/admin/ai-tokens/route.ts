import { adminRespond } from "@/lib/admin-http"
import { readBody } from "@/lib/http"
import { createToken, listTokens } from "@/lib/services/ai-tokens"

export const dynamic = "force-dynamic"

// 一覧（トークンの平文・ハッシュは返さない）
export async function GET(req: Request) {
  return adminRespond(req, async () => ({ tokens: await listTokens() }))
}

// 発行（平文のトークンはこの応答で1回だけ返す）
export async function POST(req: Request) {
  return adminRespond(req, async () => createToken(await readBody(req)), 201)
}
