import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { deleteFixedEvent, updateFixedEvent } from "@/lib/services/schedule"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => updateFixedEvent(UI_PRINCIPAL, params.id, await readBody(req)))
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return respond(async () => deleteFixedEvent(UI_PRINCIPAL, params.id))
}
