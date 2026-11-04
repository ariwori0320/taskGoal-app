import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { loadSettings, saveSettings } from "@/lib/services/settings"

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

export async function GET() {
  return respond(async () => loadSettings(UI_PRINCIPAL.userId))
}

export async function PATCH(req: Request) {
  return respond(async () => {
    const body = await readBody(req)
    return saveSettings(UI_PRINCIPAL, {
      ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
      ...(body.presets !== undefined ? { presets: body.presets as never } : {}),
      ...(body.bufferMinutes !== undefined ? { bufferMinutes: body.bufferMinutes as number } : {}),
    })
  })
}
