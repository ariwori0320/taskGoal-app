// モックDBを単体で起動する。  node scripts/mock-supabase-cli.mjs [port]
import { createMockSupabase } from "./mock-supabase.mjs"

const mock = createMockSupabase()
const port = await mock.listen(Number(process.argv[2] ?? 54321))
console.log(`mock supabase: http://127.0.0.1:${port}/rest/v1`)
