import { db } from "./db"
import { newId } from "./id"
import type { EventType } from "./types"

export interface EventInput {
  type: EventType
  mode?: string | null
  task_id?: string | null
  timebox_id?: string | null
  payload?: Record<string, unknown>
}

/**
 * 履歴・監査ログに1件追記する。
 * ログの失敗（テーブル未作成を含む）で本来の操作を止めてはいけないので、絶対に throw しない。
 */
export async function recordEvent(who: { userId: string; actor: string }, e: EventInput): Promise<void> {
  try {
    await db.insert("myflow_events", {
      id: newId("ev_"),
      user_id: who.userId,
      mode: e.mode ?? null,
      type: e.type,
      task_id: e.task_id ?? null,
      timebox_id: e.timebox_id ?? null,
      actor: who.actor,
      payload: e.payload ?? {},
    })
  } catch (err) {
    // 履歴は補助情報。失敗は握りつぶすが、原因調査のためサーバーログには残す
    console.warn("[events] 記録に失敗:", (err as Error)?.message?.slice(0, 200))
  }
}
