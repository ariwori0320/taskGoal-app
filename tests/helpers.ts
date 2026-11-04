import { createMockSupabase } from "../scripts/mock-supabase.mjs"
import type { Principal, Scope } from "../lib/principal"

type MockOpts = { newTables?: boolean; missingColumns?: string[] }

/**
 * モックDBを起動し、db.ts の接続先をそこへ向ける。
 * ⚠️ 必ず lib/services などDBを使うモジュールを import する「前」に呼ぶこと（db.ts は読み込み時に接続先を決める）。
 * 本番のSupabaseへは絶対に接続しない（ローカル以外なら即座に失敗させる）。
 */
export async function startMock(opts: MockOpts = {}) {
  const mock = createMockSupabase(opts)
  const port = await mock.listen(0)
  const url = `http://127.0.0.1:${port}/rest/v1`
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("テストはローカルのモックDB以外に接続してはいけません")
  process.env.SUPABASE_REST_URL = url
  process.env.SB_KEY = "test-key"
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  return mock
}

export const ai = (modes: ("work" | "private")[], scopes: Scope[], name = "test"): Principal => ({
  kind: "ai", userId: "default", modes, scopes, actor: `ai:${name}`,
})

export const ALL: Scope[] = ["read", "task_add", "task_edit", "schedule", "complete", "delete"]

/** 現在時刻(分)を含まない時間帯（実行時刻に依存せず「時間帯を外した」状況を作る） */
export function windowAvoiding(nowMinutes: number): { start: number; end: number } {
  return nowMinutes >= 720 ? { start: 0, end: 60 } : { start: 1380, end: 1440 }
}
