"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSession, signOut } from "next-auth/react"
import { useRouter } from "next/navigation"
import Image from "next/image"

type Mode = "work" | "private"
type Priority = "high" | "mid" | "low"
type Filter = "all" | "active" | "done"

interface Task {
  id: string
  text: string
  priority: Priority
  due_date: string | null
  done: boolean
  created_at: string
}

interface Goal {
  id: string
  text: string
  due_date: string | null
  pct: number
  created_at: string
}

interface ModeData {
  tasks: Task[]
  goals: Goal[]
}

function fmtDue(dateStr: string | null): string {
  if (!dateStr) return ""
  const d = new Date(dateStr + "T00:00:00")
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - now.getTime()) / 86400000)
  if (diff === 0) return "今日"
  if (diff === 1) return "明日"
  if (diff < 0) return `${Math.abs(diff)}日超過`
  return `${diff}日後`
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false
  const d = new Date(dateStr + "T00:00:00")
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return d < now
}

export default function Home() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [mode, setMode] = useState<Mode>("work")
  const [data, setData] = useState<Record<Mode, ModeData>>({
    work: { tasks: [], goals: [] },
    private: { tasks: [], goals: [] },
  })
  const [filter, setFilter] = useState<Record<Mode, Filter>>({ work: "all", private: "all" })
  const [loading, setLoading] = useState(true)

  // Task form
  const [taskText, setTaskText] = useState("")
  const [taskPriority, setTaskPriority] = useState<Priority>("mid")
  const [taskDue, setTaskDue] = useState("")

  // Goal form
  const [goalText, setGoalText] = useState("")
  const [goalDue, setGoalDue] = useState("")

  // Debounce goal pct updates
  const pctTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const [wt, wg, pt, pg] = await Promise.all([
      fetch("/api/tasks?mode=work").then((r) => r.json()),
      fetch("/api/goals?mode=work").then((r) => r.json()),
      fetch("/api/tasks?mode=private").then((r) => r.json()),
      fetch("/api/goals?mode=private").then((r) => r.json()),
    ])
    setData({ work: { tasks: wt, goals: wg }, private: { tasks: pt, goals: pg } })
    setLoading(false)
  }, [])

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login")
    if (status === "authenticated") fetchAll()
  }, [status, fetchAll, router])

  // Task actions
  async function addTask() {
    if (!taskText.trim()) return
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: taskText, priority: taskPriority, due_date: taskDue || null, mode }),
    })
    const task: Task = await res.json()
    setData((prev) => ({ ...prev, [mode]: { ...prev[mode], tasks: [task, ...prev[mode].tasks] } }))
    setTaskText("")
    setTaskDue("")
  }

  async function toggleTask(id: string, done: boolean) {
    setData((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], tasks: prev[mode].tasks.map((t) => (t.id === id ? { ...t, done: !done } : t)) },
    }))
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !done }),
    })
  }

  async function deleteTask(id: string) {
    setData((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], tasks: prev[mode].tasks.filter((t) => t.id !== id) },
    }))
    await fetch(`/api/tasks/${id}`, { method: "DELETE" })
  }

  // Goal actions
  async function addGoal() {
    if (!goalText.trim()) return
    const res = await fetch("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: goalText, due_date: goalDue || null, mode }),
    })
    const goal: Goal = await res.json()
    setData((prev) => ({ ...prev, [mode]: { ...prev[mode], goals: [goal, ...prev[mode].goals] } }))
    setGoalText("")
    setGoalDue("")
  }

  function updateGoalPctLocal(id: string, pct: number) {
    setData((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], goals: prev[mode].goals.map((g) => (g.id === id ? { ...g, pct } : g)) },
    }))
    clearTimeout(pctTimers.current[id])
    pctTimers.current[id] = setTimeout(() => {
      fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pct }),
      })
    }, 400)
  }

  async function deleteGoal(id: string) {
    setData((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], goals: prev[mode].goals.filter((g) => g.id !== id) },
    }))
    await fetch(`/api/goals/${id}`, { method: "DELETE" })
  }

  // Derived
  const cur = data[mode]
  const f = filter[mode]
  const filteredTasks =
    f === "active" ? cur.tasks.filter((t) => !t.done) : f === "done" ? cur.tasks.filter((t) => t.done) : cur.tasks
  const activeCnt = cur.tasks.filter((t) => !t.done).length
  const doneCnt = cur.tasks.filter((t) => t.done).length
  const overdueCnt = cur.tasks.filter((t) => !t.done && isOverdue(t.due_date)).length
  const avgGoal = cur.goals.length
    ? Math.round(cur.goals.reduce((a, g) => a + g.pct, 0) / cur.goals.length)
    : 0

  const mc = mode // "work" | "private"
  const accentCls = mc === "work" ? "work" : "private"

  if (status === "loading" || status === "unauthenticated") return <div className="loading">読み込み中...</div>

  return (
    <>
      <header className="header">
        <div className="logo">📋 MyFlow</div>
        <div className="header-right">
          <div className="mode-toggle">
            <button
              className={`mode-btn ${mode === "work" ? "active-work" : ""}`}
              onClick={() => setMode("work")}
            >
              💼 仕事
            </button>
            <button
              className={`mode-btn ${mode === "private" ? "active-priv" : ""}`}
              onClick={() => setMode("private")}
            >
              🏠 プライベート
            </button>
          </div>
          <div className="user-area">
            {session?.user?.image && (
              <Image
                src={session.user.image}
                alt="avatar"
                width={32}
                height={32}
                className="user-avatar"
              />
            )}
            <span className="user-name">{session?.user?.name}</span>
            <button className="signout-btn" onClick={() => signOut()}>
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <div className="container">
        {/* Stats */}
        <div className="stats">
          <div className="stat">
            <div className={`stat-num stat-num-${accentCls}`}>{activeCnt}</div>
            <div className="stat-label">未完了タスク</div>
          </div>
          <div className="stat">
            <div className={`stat-num stat-num-${accentCls}`}>{doneCnt}</div>
            <div className="stat-label">完了タスク</div>
          </div>
          <div className="stat">
            <div className={`stat-num stat-num-${accentCls}`}>{overdueCnt}</div>
            <div className="stat-label">期限超過</div>
          </div>
          <div className="stat">
            <div className={`stat-num stat-num-${accentCls}`}>{avgGoal}%</div>
            <div className="stat-label">目標平均進捗</div>
          </div>
        </div>

        {/* Tasks */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <span>✅</span> タスク
            </div>
            <span className={`badge badge-${accentCls}`}>
              {mc === "work" ? "仕事" : "プライベート"}
            </span>
          </div>
          <div className="input-row">
            <input
              className="input-main"
              type="text"
              placeholder="新しいタスクを追加..."
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTask()}
            />
            <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as Priority)}>
              <option value="high">🔴 高</option>
              <option value="mid">🟠 中</option>
              <option value="low">🟢 低</option>
            </select>
            <input
              className="input-date"
              type="date"
              value={taskDue}
              onChange={(e) => setTaskDue(e.target.value)}
            />
            <button className={`add-btn add-btn-${accentCls}`} onClick={addTask}>
              +
            </button>
          </div>

          <div className="filter-tabs">
            {(["all", "active", "done"] as Filter[]).map((ff) => (
              <button
                key={ff}
                className={`filter-tab ${f === ff ? "active" : ""}`}
                onClick={() => setFilter((prev) => ({ ...prev, [mode]: ff }))}
              >
                {ff === "all" ? "すべて" : ff === "active" ? "未完了" : "完了"}
              </button>
            ))}
          </div>

          <div className="list-body">
            {loading ? (
              <div className="empty-msg">読み込み中...</div>
            ) : filteredTasks.length === 0 ? (
              <div className="empty-msg">タスクがありません</div>
            ) : (
              filteredTasks.map((t) => (
                <div className="task-item" key={t.id}>
                  <div
                    className={`task-check ${t.done ? "task-check-done" : ""}`}
                    onClick={() => toggleTask(t.id, t.done)}
                  >
                    {t.done ? "✓" : ""}
                  </div>
                  <div className={`priority-dot p-${t.priority}`} />
                  <div className={`task-text ${t.done ? "task-text-done" : ""}`}>{t.text}</div>
                  {t.due_date && (
                    <div className={`task-due ${!t.done && isOverdue(t.due_date) ? "task-due-overdue" : ""}`}>
                      {fmtDue(t.due_date)}
                    </div>
                  )}
                  <button className="del-btn" onClick={() => deleteTask(t.id)}>
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Goals */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <span>🎯</span> 目標
            </div>
            <span className={`badge badge-${accentCls}`}>
              {mc === "work" ? "仕事" : "プライベート"}
            </span>
          </div>
          <div className="input-row">
            <input
              className="input-main"
              type="text"
              placeholder="新しい目標を追加..."
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addGoal()}
            />
            <input
              className="input-date"
              type="date"
              value={goalDue}
              onChange={(e) => setGoalDue(e.target.value)}
            />
            <button className={`add-btn add-btn-${accentCls}`} onClick={addGoal}>
              +
            </button>
          </div>

          <div className="list-body">
            {loading ? (
              <div className="empty-msg">読み込み中...</div>
            ) : cur.goals.length === 0 ? (
              <div className="empty-msg">目標がありません</div>
            ) : (
              cur.goals.map((g) => (
                <div className="goal-item" key={g.id}>
                  <div className="goal-top">
                    <div className={`goal-name ${g.pct >= 100 ? "goal-name-done" : ""}`}>{g.text}</div>
                    <div className={`goal-pct goal-pct-${accentCls}`}>{g.pct}%</div>
                    <button className="del-btn" onClick={() => deleteGoal(g.id)}>
                      ×
                    </button>
                  </div>
                  <div className="progress-bar">
                    <div className={`progress-fill progress-${accentCls}`} style={{ width: `${g.pct}%` }} />
                  </div>
                  <div className="goal-controls">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={g.pct}
                      onChange={(e) => updateGoalPctLocal(g.id, Number(e.target.value))}
                    />
                    {g.due_date && <div className="goal-due">{fmtDue(g.due_date)}</div>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
}
