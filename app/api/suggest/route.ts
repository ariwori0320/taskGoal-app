import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { task } = await req.json()
  if (!task?.trim()) return NextResponse.json({ error: "task required" }, { status: 400 })

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `以下のタスクを「5秒で次の一手が選べる」レベルの具体的なサブタスクに分解してください。

タスク：「${task}」

条件：
- 各サブタスクは「自分が動いている場面を頭の中で映像として再生できる」レベルに具体的に
- 3〜5個のサブタスクを提案
- 各サブタスクは短く（15文字以内）
- JSON配列のみで返す（説明文不要）

例：["参考記事を3本開く", "構成をメモに書く", "AIに下書きを入力する", "修正して投稿する"]

JSON配列のみ返してください：`,
      },
    ],
  })

  const text = message.content[0].type === "text" ? message.content[0].text : "[]"
  try {
    return NextResponse.json({ suggestions: JSON.parse(text.trim()) })
  } catch {
    return NextResponse.json({ suggestions: [] })
  }
}
