// 管理キーの総当たり対策: 認証に失敗した回数を接続元ごとに数え、短時間に多すぎれば一定時間ブロックする。
// 記録はこのプロセスのメモリ上のみ（サーバーレスではインスタンスごと）。多層の守りの一つで、
// 本命は「管理キーを長いランダム文字列にする」こと（MCP-SETUP.md）。

export const MAX_FAILURES = 10
export const WINDOW_MS = 10 * 60 * 1000

interface Entry { count: number; first: number }
const failures = new Map<string, Entry>()
const MAX_TRACKED = 5000 // メモリを使い果たされないための上限

/** 接続元の識別子。Vercel などのプロキシが付ける転送元アドレスを使う */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return fwd || req.headers.get("x-real-ip")?.trim() || "unknown"
}

/** ブロック中なら、再試行できるまでの秒数。そうでなければ 0。 */
export function blockedSeconds(key: string, now: number = Date.now()): number {
  const e = failures.get(key)
  if (!e) return 0
  if (now - e.first >= WINDOW_MS) { failures.delete(key); return 0 }
  return e.count >= MAX_FAILURES ? Math.ceil((e.first + WINDOW_MS - now) / 1000) : 0
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const e = failures.get(key)
  if (!e || now - e.first >= WINDOW_MS) {
    if (failures.size >= MAX_TRACKED) {
      // 期限切れを掃除し、それでも多ければ最も古いものから捨てる
      failures.forEach((v, k) => { if (now - v.first >= WINDOW_MS) failures.delete(k) })
      if (failures.size >= MAX_TRACKED) { const oldest = failures.keys().next().value; if (oldest !== undefined) failures.delete(oldest) }
    }
    failures.set(key, { count: 1, first: now })
  } else {
    e.count++
  }
}

export function clearFailures(key: string): void { failures.delete(key) }

/** テスト用 */
export function resetThrottle(): void { failures.clear() }
