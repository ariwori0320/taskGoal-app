export const runtime = "edge"

export async function POST(req: Request) {
  const { task, messages } = await req.json()
  if (!task?.trim()) return Response.json({ error: "task required" }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })

  const history = messages && messages.length > 0
    ? messages
    : [{
        role: "user",
        content: `「${task}」というタスクをすぐ実行できる粒度のサブタスクに分解してください。\n\n形式：説明文（1〜2文）の後にJSONブロックで提示\n\`\`\`json\n["ステップ1", "ステップ2", ...]\n\`\`\``
      }]

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 512,
      system: "あなたはタスク分解の専門家です。各サブタスクは「頭の中で映像として再生できる」レベルに具体的にしてください。",
      messages: history,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return Response.json({ error: err }, { status: 500 })
  }

  const data = await res.json()
  const text = data.content?.[0]?.text ?? ""

  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/)
  let suggestions: string[] = []
  if (jsonMatch) {
    try { suggestions = JSON.parse(jsonMatch[1]) } catch {}
  }

  return Response.json({ text, suggestions })
}
