import test from "node:test"
import assert from "node:assert/strict"
import { addDays, diffDays, dowOf, eachDay, fmtDuration, hhmmToMinutes, isValidWindow, minutesToHhmm, nowInTz, parseYmd, weekStart } from "../lib/time"

test("nowInTz: 同じ瞬間でもタイムゾーンで日付が変わる（JST は UTC+9）", () => {
  // 2026-11-05 15:30 UTC = JST 11/06 00:30 (金)
  const a = nowInTz("Asia/Tokyo", new Date("2026-11-05T15:30:00Z"))
  assert.deepEqual(a, { date: "2026-11-06", minutes: 30, dow: 5 })
  // 2026-11-05 14:59 UTC = JST 11/05 23:59 (木)
  const b = nowInTz("Asia/Tokyo", new Date("2026-11-05T14:59:00Z"))
  assert.deepEqual(b, { date: "2026-11-05", minutes: 23 * 60 + 59, dow: 4 })
  // 同じ瞬間を UTC で見ると日付が違う
  assert.equal(nowInTz("UTC", new Date("2026-11-05T15:30:00Z")).date, "2026-11-05")
})

test("nowInTz: 不正なタイムゾーンは Asia/Tokyo にフォールバック", () => {
  const r = nowInTz("Not/AZone", new Date("2026-11-05T15:30:00Z"))
  assert.equal(r.date, "2026-11-06")
})

test("日付演算: 月またぎ・年またぎ・うるう日", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01")
  assert.equal(addDays("2026-12-31", 1), "2027-01-01")
  assert.equal(addDays("2028-02-28", 1), "2028-02-29")
  assert.equal(addDays("2027-02-28", 1), "2027-03-01")
  assert.equal(addDays("2026-11-05", -5), "2026-10-31")
  assert.equal(diffDays("2026-11-01", "2026-11-05"), 4)
})

test("曜日と週の開始（月曜始まり）", () => {
  assert.equal(dowOf("2026-11-05"), 4) // 木
  assert.equal(weekStart("2026-11-05"), "2026-11-02") // 月
  assert.equal(weekStart("2026-11-02"), "2026-11-02")
  assert.equal(weekStart("2026-11-08"), "2026-11-02") // 日曜は前の月曜の週
  assert.deepEqual(eachDay("2026-11-02", "2026-11-04"), ["2026-11-02", "2026-11-03", "2026-11-04"])
})

test("parseYmd: 存在しない日付・形式違いを弾く", () => {
  assert.equal(parseYmd("2026-02-30"), null)
  assert.equal(parseYmd("2026-2-3"), null)
  assert.equal(parseYmd("2026/02/03"), null)
  assert.equal(parseYmd(20260203), null)
  assert.deepEqual(parseYmd("2026-11-05"), { y: 2026, m: 11, d: 5 })
})

test("時刻の変換と検証", () => {
  assert.equal(hhmmToMinutes("19:00"), 1140)
  assert.equal(hhmmToMinutes("9:30"), 570)
  assert.equal(hhmmToMinutes("24:00"), 1440)
  assert.equal(hhmmToMinutes("25:00"), null)
  assert.equal(hhmmToMinutes("12:60"), null)
  assert.equal(hhmmToMinutes("abc"), null)
  assert.equal(minutesToHhmm(1140), "19:00")
  assert.equal(minutesToHhmm(570), "09:30")
  assert.equal(isValidWindow(1140, 1320), true)
  assert.equal(isValidWindow(1320, 1140), false)
  assert.equal(isValidWindow(1140, 1140), false)
  assert.equal(isValidWindow(-1, 60), false)
  assert.equal(isValidWindow(0, 1441), false)
  assert.equal(isValidWindow(1.5, 60), false)
})

test("fmtDuration", () => {
  assert.equal(fmtDuration(30), "30分")
  assert.equal(fmtDuration(60), "1時間")
  assert.equal(fmtDuration(90), "1時間30分")
  assert.equal(fmtDuration(0), "0分")
})
