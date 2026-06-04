export async function GET() {
  return Response.json({
    hasSbKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    sbKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
    sbKeyStart: process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 10) ?? "empty",
  })
}
