"use client"

import { useEffect } from "react"
import { isTaskDone } from "@/lib/task-utils"
import GoalsView from "./GoalsView"
import HomeView from "./HomeView"
import MemosView from "./MemosView"
import PlannerView from "./PlannerView"
import { SheetsProvider, useSheets } from "./sheets"
import { StoreProvider, useStore, type Mode, type Tab } from "./store"
import TasksView from "./TasksView"
import { Icon, ToastHost } from "./ui"

const NAV: { tab: Tab; label: string; icon: string }[] = [
  { tab: "home", label: "ホーム", icon: "home" },
  { tab: "planner", label: "計画", icon: "calendar" },
  { tab: "tasks", label: "タスク", icon: "list" },
  { tab: "goals", label: "目標", icon: "target" },
  { tab: "memos", label: "メモ", icon: "note" },
]

function ModeSwitch({ block }: { block?: boolean }) {
  const s = useStore()
  const items: { m: Mode; label: string }[] = [{ m: "work", label: "仕事" }, { m: "private", label: "プライベート" }]
  return (
    <div className={`seg${block ? " block" : ""}`} role="group" aria-label="カテゴリ">
      {items.map(it => (
        <button key={it.m} type="button" aria-pressed={s.mode === it.m} onClick={() => s.setMode(it.m)}>
          <span className="cat-dot" data-mode={it.m} />{it.label}
        </button>
      ))}
    </div>
  )
}

function Shell() {
  const s = useStore()
  const sheets = useSheets()
  const activeCount = s.tasks.filter(t => !t.parent_id && !isTaskDone(t, s.today)).length

  // Ctrl/Cmd+Z で、計画画面の直前の変更を元に戻す（入力中は邪魔しない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return
      if (document.querySelector("[role=dialog]")) return
      if (s.tab === "planner") { e.preventDefault(); s.undo() }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [s])

  const view = !s.ready ? <div className="page"><p className="empty">読み込み中…</p></div> : (
    s.tab === "home" ? <HomeView /> : s.tab === "planner" ? <PlannerView /> : s.tab === "tasks" ? <TasksView /> : s.tab === "goals" ? <GoalsView /> : <MemosView />
  )

  return (
    <div className="app">
      <aside className="sidebar" aria-label="メニュー">
        <div className="wordmark"><i />MyFlow</div>
        <ModeSwitch block />
        <nav className="nav" aria-label="画面">
          {NAV.map(n => (
            <button key={n.tab} type="button" className="nav-item" aria-current={s.tab === n.tab ? "page" : undefined} onClick={() => s.setTab(n.tab)}>
              <Icon name={n.icon} />{n.label}
              {n.tab === "tasks" && s.ready && <span className="n num">{activeCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="nav-item" onClick={() => sheets.open({ kind: "settings" })}><Icon name="gear" />設定</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="wordmark"><i />MyFlow</div>
          <ModeSwitch />
          <button type="button" className="btn icon" aria-label="設定" onClick={() => sheets.open({ kind: "settings" })}><Icon name="gear" /></button>
        </header>
        {s.migration && (
          <div className="page" style={{ marginBottom: 0 }}>
            <div className="notice warn" role="status">
              <div>
                <b>計画の機能を使うには、データベースの更新が必要です。</b>
                <div>Supabase の SQL Editor で <code>db/migrations/001_myflow_renewal.sql</code> を実行してください。いまのタスク・目標・メモはそのまま使えます。</div>
              </div>
            </div>
          </div>
        )}
        {view}
      </main>

      <nav className="bottomnav" aria-label="画面">
        {NAV.map(n => (
          <button key={n.tab} type="button" aria-current={s.tab === n.tab ? "page" : undefined} onClick={() => s.setTab(n.tab)}>
            <Icon name={n.icon} />{n.label}
          </button>
        ))}
      </nav>
      <ToastHost toasts={s.toasts} dismiss={s.dismiss} />
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <SheetsProvider>
        <Shell />
      </SheetsProvider>
    </StoreProvider>
  )
}
