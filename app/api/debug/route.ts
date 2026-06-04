export async function GET() {
  return Response.json({
    hasSbKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasSbKeyShort: !!process.env.SB_KEY,
    sbKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
    sbKeyShortLength: process.env.SB_KEY?.length ?? 0,
  })
}
