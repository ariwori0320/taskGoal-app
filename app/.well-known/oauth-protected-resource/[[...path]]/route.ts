import { origin } from "@/lib/oauth"

export const dynamic = "force-dynamic"

// 保護対象(MCP)のメタデータ。クライアントは、どの認可サーバーで認証すればよいかをここで知る。
export async function GET(req: Request) {
  const o = origin(req)
  return Response.json({ resource: `${o}/api/connect/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"] })
}
