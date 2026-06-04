import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = "https://giormjyjrdyzcbsrmoeb.supabase.co"

export function getSupabase() {
  return createClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
