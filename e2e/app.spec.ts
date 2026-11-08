import { test, expect, type Page } from "@playwright/test"

// 同じモックDBを順に使うので、各テストは自分で作ったデータだけを前提にする。
const uniq = () => `E2E-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`

async function open(page: Page) {
  const errors: string[] = []
  page.on("pageerror", e => errors.push(String(e)))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: /今日|ホーム/ }).first()).toBeVisible({ timeout: 20_000 })
  return errors
}
// ナビのラベルには件数などが付くことがあるので、先頭一致で探す
const nav = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^${label}`) }).last().click()

test("ホームが開き、画面エラーが出ない", async ({ page }) => {
  const errors = await open(page)
  await expect(page.getByRole("textbox", { name: "タスクを追加", exact: true })).toBeVisible()
  expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([])
})

test("タスクを追加して完了にできる（追加→一覧に出る→チェックで完了）", async ({ page }) => {
  await open(page)
  const name = uniq()
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).fill(name)
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).press("Enter")
  await expect(page.getByText(name).first()).toBeVisible()
  await page.getByRole("checkbox", { name: `${name} を完了にする` }).first().click()
  await expect(page.getByRole("checkbox", { name: `${name} を完了にする` })).toHaveCount(0)
})

test("仕事とプライベートのデータが混ざらない", async ({ page }) => {
  await open(page)
  const name = uniq()
  await page.getByRole("button", { name: "プライベート" }).first().click()
  await nav(page, "タスク")
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).fill(name)
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).press("Enter")
  await expect(page.getByText(name).first()).toBeVisible()
  await page.getByRole("button", { name: "仕事", exact: true }).first().click()
  await expect(page.getByText(name)).toHaveCount(0)
  await page.getByRole("button", { name: "プライベート" }).first().click()
  await expect(page.getByText(name).first()).toBeVisible()
})

test("PC幅: 週間プランナーが出て、未配置のタスクを枠へドラッグして予定にできる", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page)
  const name = uniq()
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).fill(name)
  await page.getByRole("textbox", { name: "タスクを追加", exact: true }).press("Enter")
  await nav(page, "計画")
  await expect(page.getByRole("group", { name: "週間プランナー" })).toBeVisible()
  const item = page.locator(".unplaced-item", { hasText: name }).first()
  await expect(item).toBeVisible()
  await item.dragTo(page.locator(".day-col.is-today .slot").first())
  // 枠に置くと予定になり、「未配置」から消える
  await expect(page.locator(".unplaced-item", { hasText: name })).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator(".day-col.is-today", { hasText: name })).toBeVisible()
})

test("スマホ幅: 日付の帯が出て、選択中の日付が帯の中に見える（R-05）", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // 今日が週の最後（日曜）だと、日付の帯の右端に隠れやすい。時計を日曜に固定して確実に再現する
  await page.clock.setFixedTime(new Date("2026-11-08T12:00:00+09:00"))
  await open(page)
  await nav(page, "計画")
  await expect(page.locator(".daystrip [aria-pressed='true']")).toHaveAttribute("aria-label", /11[/]8/)
  const strip = page.locator(".daystrip")
  await expect(strip).toBeVisible()
  const sel = strip.locator("[aria-pressed='true']")
  await expect(sel).toBeVisible()
  const [s, c] = [await strip.boundingBox(), await sel.boundingBox()]
  expect(c!.x).toBeGreaterThanOrEqual(s!.x - 1)
  expect(c!.x + c!.width).toBeLessThanOrEqual(s!.x + s!.width + 1)
  // ページ全体が横にはみ出さない
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test("シートを閉じると、開いた元のボタンへフォーカスが戻る（R-06）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page)
  await nav(page, "計画")
  const add = page.getByRole("button", { name: /に予定を追加/ }).first()
  await add.focus()
  await add.click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(add).toBeFocused()
})

test("子・孫タスクは、一覧で親の経路つきで表示される", async ({ page, request }) => {
  const mk = async (body: Record<string, unknown>) => (await (await request.post("/api/tasks", { data: body })).json()) as { id: string }
  const root = uniq(), mid = uniq(), leaf = uniq()
  const r = await mk({ text: root, mode: "work" })
  const m = await mk({ text: mid, mode: "work", parent_id: r.id })
  await mk({ text: leaf, mode: "work", parent_id: m.id, estimate_minutes: 30, due_date: "2099-01-01" })
  await open(page)
  await page.getByRole("button", { name: "仕事", exact: true }).first().click()
  await nav(page, "計画")
  await expect(page.locator(".crumb", { hasText: `${root} › ${mid}` }).first()).toBeVisible({ timeout: 15_000 })
})
