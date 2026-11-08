import { adminRespond } from "@/lib/admin-http"
import { listAudit } from "@/lib/services/ai-tokens"

export const dynamic = "force-dynamic"

// 操作履歴（?limit=50&ai=1 で AI からの操作だけ）
export async function GET(req: Request) {
  return adminRespond(req, async () => {
    const sp = new URL(req.url).searchParams
    return { events: await listAudit({ limit: Number(sp.get("limit") ?? 50) || 50, aiOnly: sp.get("ai") === "1" }) }
  })
}
