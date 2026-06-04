import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  const { task, messages } = await req.json()
  if (!task?.trim()) return NextResponse.json({ error: "task required" }, { status: 400 })

  const systemPrompt = `あなたはタスク分解の専門家です。ユーザーのタスクを「すぐに実行できる粒度」に分解します。

重要なルール：
- 各サブタスクは「自分が実際に動いている場面を頭の中で映像として再生できる」レベルに具体的に
- 抽象的な表現（「調査する」「考える」）ではなく、具体的な行動（「〇〇のサイトを開く」「メモ帳に書き出す」）
- 1つのサブタスクは5分以内でできる粒度が理想
- ユーザーとの対話を通じてどんどん具体化していく`

  const chatMessages = messages && messages.length > 0
    ? messages
    : [{
        role: "user" as const,
        content: `「${task}」というタスクをすぐに実行できる粒度のサブタスクに分解してください。まず何をしてくれるか簡単に説明してから、具体的なステップをJSON配列で提示してください。

形式：
説明文（1〜2文）

\`\`\`json
["ステップ1", "ステップ2", ...]
\`\`\``
      }]

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: chatMessages,
  })

  const text = response.content[0].type === "text" ? response.content[0].text : ""

  // JSONブロックを抽出
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/)
  let suggestions: string[] = []
  if (jsonMatch) {
    try { suggestions = JSON.parse(jsonMatch[1]) } catch {}
  }

  return NextResponse.json({ text, suggestions })
}
