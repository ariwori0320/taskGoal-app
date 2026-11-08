"use client"

import { useEffect, useId, useRef, useState, type ReactNode } from "react"

// ---------- アイコン（意味のある場所だけで使う。外部ライブラリは使わない） ----------

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><path d="M12 12h.01" /></>,
  note: <><path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V3.5Z" /><path d="M9 12h7M9 16h5" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  undo: <path d="M9 7 4.5 11.5 9 16M5 11.5h8.5a5.5 5.5 0 0 1 0 11H11" />,
  left: <path d="M14.5 6 8.5 12l6 6" />,
  right: <path d="M9.5 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
}

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}

// ---------- チェック（完了の手応え：チェックが描かれ、軽く弾み、波紋が広がる） ----------

/** mixed: 予定(今日の分)は実施したが、タスクはまだ完了していない状態。押すとタスクを完了にする。 */
export function Check({ checked, onChange, label, small, mixed }: { checked: boolean; onChange: (next: boolean) => void; label: string; small?: boolean; mixed?: boolean }) {
  const [pop, setPop] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed && !checked ? "mixed" : checked}
      aria-label={label}
      className={`check${small ? " sm" : ""}${pop ? " pop" : ""}`}
      onClick={e => {
        e.stopPropagation()
        if (!checked) {
          setPop(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setPop(false), 700)
        }
        onChange(!checked)
      }}
    >
      <span className="check-box">
        <svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 7.8" /></svg>
      </span>
    </button>
  )
}

// ---------- シート（PCは中央のモーダル、スマホは下からのシート） ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const root = ref.current
    // 最初の入力欄（なければ最初の操作部品）へフォーカス
    const first = root?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=range]), textarea, select") ?? root?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return }
      if (e.key !== "Tab" || !root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null)
      if (items.length === 0) return
      const a = items[0], z = items[items.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
    }
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.body.style.overflow = prevOverflow
      previous?.focus?.({ preventScroll: true })
    }
  }, [])

  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`sheet${wide ? " lg" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn icon" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---------- メニュー（行の「…」） ----------

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; divider?: boolean }

export function Menu({ label, items, up }: { label: string; items: MenuItem[]; up?: boolean }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); wrap.current?.querySelector<HTMLElement>("button")?.focus() }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const els = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
        const i = els.indexOf(document.activeElement as HTMLElement)
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus()
      }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [open])

  return (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className="btn icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
        <Icon name="more" />
      </button>
      {open && (
        <div className={`menu${up ? " up" : ""}`} role="menu">
          {items.map((it, i) => it.divider ? <hr key={i} /> : (
            <button key={i} type="button" role="menuitem" className={`menu-item${it.danger ? " danger" : ""}`} onClick={e => { e.stopPropagation(); setOpen(false); it.onClick() }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- トースト ----------

export interface ToastItem { id: number; text: string; kind?: "error" | "info"; action?: { label: string; run: () => void } }

export function ToastHost({ toasts, dismiss }: { toasts: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-wrap" aria-live="polite" role="status">
      {toasts.map(t => (
        <div key={t.id} className={`toast${t.kind === "error" ? " error" : ""}`}>
          <span>{t.text}</span>
          {t.action && <button type="button" onClick={() => { t.action!.run(); dismiss(t.id) }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  )
}
