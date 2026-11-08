import { respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { getSchedule } from "@/lib/services/schedule"

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

// GET /api/planner?mode=work&from=YYYY-MM-DD&to=YYYY-MM-DD&includeOther=1
// 期間のタイムボックス・固定予定・余白と警告・設定をまとめて返す（画面用）
export async function GET(req: Request) {
  return respond(async () => {
    const sp = new URL(req.url).searchParams
    return getSchedule(UI_PRINCIPAL, {
      mode: sp.get("mode"),
      from: sp.get("from") ?? "",
      to: sp.get("to") ?? "",
      includeOther: sp.get("includeOther") === "1",
    })
  })
}
