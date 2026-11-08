// ローカル確認用のサンプルデータ（モックDB専用。本番には投入しない）。
// 「今日」を基準に、画面で確認したい場面（予定の重なり・先送り・未配置・繰り返し）を一通り含める。

const DAY = 86400000

export function todayJst(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now)
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + n * DAY)
  return dt.toISOString().slice(0, 10)
}

export function buildSeed(today = todayJst()) {
  const T = n => addDays(today, n)
  const at = n => new Date(Date.parse(`${T(n)}T03:00:00Z`)).toISOString()
  const NIGHT = { window_start: 1140, window_end: 1320, preset: "night" }
  const NOON = { window_start: 720, window_end: 1020, preset: "noon" }
  const MORNING = { window_start: 360, window_end: 600, preset: "morning" }

  const task = (id, mode, text, extra = {}) => ({
    id, user_id: "default", mode, text, priority: "mid", start_date: null, due_date: null, done: false,
    parent_id: null, memo: null, is_recurring: false, recurring_days: "", recurring_done_date: null,
    sort_order: null, created_at: at(-3), ...extra,
  })
  const box = (id, task_id, mode, date, win, planned_minutes, extra = {}) => ({
    id, user_id: "default", mode, task_id, date, ...win, planned_minutes, status: "planned",
    actual_minutes: null, kept_window: null, completed_at: null, created_at: at(-2), updated_at: at(-2), ...extra,
  })
  const fixed = (id, mode, title, date, start_min, end_min, repeat_days = "", extra = {}) => ({
    id, user_id: "default", mode, title, date, start_min, end_min, repeat_days, until: null,
    created_at: at(-10), updated_at: at(-10), ...extra,
  })
  const goal = (id, mode, text, pct, due_date = null) => ({ id, user_id: "default", mode, text, due_date, pct, created_at: at(-20) })

  const tasks = [
    // ---- プライベート ----
    task("p1", "private", "TikTok動画を編集する", { priority: "high", due_date: T(4), estimate_minutes: 120, goal_id: "g2", sort_order: 1 }),
    task("p2", "private", "英語の勉強", { is_recurring: true, recurring_days: "", estimate_minutes: 30, goal_id: "g1" }),
    task("p3", "private", "部屋を片付ける", { priority: "low", due_date: T(2), estimate_minutes: 45 }),
    task("p4", "private", "確定申告の資料を集める", { due_date: T(10), memo: "国税庁 https://www.e-tax.nta.go.jp/ を確認" }),
    task("p4a", "private", "源泉徴収票を探す", { parent_id: "p4", estimate_minutes: 15 }),
    task("p4b", "private", "領収書を撮影する", { parent_id: "p4", estimate_minutes: 20 }),
    task("p5", "private", "ジムの予約を取る", { priority: "high", due_date: T(0), estimate_minutes: 10 }),
    task("p6", "private", "歯医者の予約", { done: true }),
    task("p7", "private", "ブログ記事を書く", { estimate_minutes: 90 }),
    task("p8", "private", "請求書の内容を確認する", { estimate_minutes: 30, due_date: T(1) }),
    // ---- 仕事（別カテゴリの内容が混ざらないことの確認用） ----
    task("w1", "work", "新規プロジェクトの企画書（社外秘）", { priority: "high", due_date: T(1), estimate_minutes: 90 }),
    task("w2", "work", "週次レポートを作る", { is_recurring: true, recurring_days: "5", estimate_minutes: 30 }),
    task("w3", "work", "クライアントAの見積もりを修正", { due_date: T(3), estimate_minutes: 40 }),
    task("w4", "work", "経費精算", { priority: "low" }),
  ]

  const timeboxes = [
    box("tb1", "p1", "private", T(0), NIGHT, 30),
    box("tb2", "p1", "private", T(1), NIGHT, 60),
    box("tb3", "p1", "private", T(2), NIGHT, 30),
    box("tb4", "p4b", "private", T(1), NOON, 20),
    box("tb5", "p7", "private", T(3), MORNING, 60),
    // 昨日の予定（未実施のまま）→ 立て直しの対象
    box("tb6", "p8", "private", T(-1), NIGHT, 30),
    // 先送りされた履歴のある予定
    box("tb7", "p3", "private", T(0), NIGHT, 30),
    box("tb8", "w1", "work", T(0), NOON, 60),
    box("tb9", "w3", "work", T(2), NOON, 40),
    // 昨日実施済み（時間帯を守れた例）
    box("tb10", "p2", "private", T(-1), NIGHT, 30, { status: "done", actual_minutes: 30, kept_window: true, completed_at: at(-1) }),
  ]

  const fixedEvents = [
    fixed("fx1", "work", "仕事", T(-((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7)), 570, 1110, "1,2,3,4,5", { allows_tasks: true }),
    fixed("fx2", "private", "ジム", T(0), 1170, 1230),
    fixed("fx3", "private", "ジム", T(1), 1170, 1230),
    // 別カテゴリとの重なり（プライベートの「ジム」と仕事の夜の会議）
    fixed("fx4", "work", "夜の打ち合わせ（社外秘）", T(1), 1200, 1260),
  ]

  const goals = [
    goal("g1", "private", "英語を話せるようになる", 40, T(120)),
    goal("g2", "private", "TikTokのフォロワー1000人", 30, T(60)),
    goal("g3", "work", "資格試験に合格する", 10, T(90)),
  ]

  const memos = [
    { id: "m1", user_id: "default", mode: "private", title: "動画のアイデア", content: "朝の習慣シリーズ\nhttps://example.com/ref", tags: "創作,動画", updated_at: at(-1), created_at: at(-5) },
    { id: "m2", user_id: "default", mode: "work", title: "会議メモ（社外秘）", content: "機密の内容", tags: "会議", updated_at: at(-2), created_at: at(-6) },
  ]

  const highlights = [
    { id: "h1", user_id: "default", mode: "private", year_text: "健康と創作を両立する一年にする", month_text: "", updated_at: at(-30), created_at: at(-30) },
  ]

  const events = [
    { id: "e1", user_id: "default", mode: "private", type: "task_completed", task_id: "p2", timebox_id: "tb10", actor: "ui", payload: { kept_window: true, had_timebox: true }, created_at: at(-1) },
    { id: "e2", user_id: "default", mode: "private", type: "timebox_postponed", task_id: "p3", timebox_id: "tb7", actor: "ui", payload: { from: T(-2), to: T(-1) }, created_at: at(-2) },
    { id: "e3", user_id: "default", mode: "private", type: "timebox_postponed", task_id: "p3", timebox_id: "tb7", actor: "ui", payload: { from: T(-1), to: T(0) }, created_at: at(-1) },
  ]

  return { tasks, myflow_timeboxes: timeboxes, myflow_fixed_events: fixedEvents, goals, memos, highlights, myflow_events: events }
}

/** モックの store にサンプルを投入する */
export function loadSeed(mock, today) {
  const seed = buildSeed(today)
  for (const [table, rows] of Object.entries(seed)) {
    if (mock.store[table]) mock.store[table].push(...rows)
  }
  return seed
}
