import { createMcpHandler } from "mcp-handler"
import { authenticateAi } from "@/lib/ai-auth"
import { registerTools } from "@/lib/mcp-tools"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// ChatGPT / Claude から MyFlow を操作する MCP エンドポイント（認証付き）。
// リクエストごとにトークンを検証し、そのトークンの権限(カテゴリ・操作)に合うツールだけを公開する。
async function handle(req: Request): Promise<Response> {
  const auth = await authenticateAi(req)
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "content-type": "application/json", ...(auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) },
    })
  }
  const handler = createMcpHandler(
    server => registerTools(server, auth.principal),
    { serverInfo: { name: "myflow", version: "2.0.0" } },
    { basePath: "/api/connect", maxDuration: 60, verboseLogs: false },
  )
  return handler(req)
}

export { handle as GET, handle as POST, handle as DELETE }
