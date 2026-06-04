export async function GET() {
  return Response.json({
    hasSbKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasSbKeyShort: !!process.env.SB_KEY,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    anthropicKeyLength: process.env.ANTHROPIC_API_KEY?.length ?? 0,
  })
}
