import { randomBytes } from "node:crypto"

/** 推測されにくいID。既存の tasks.id(文字列) と同じ「text」列に入れられる。 */
export function newId(prefix = ""): string {
  return `${prefix}${randomBytes(12).toString("base64url")}`
}
