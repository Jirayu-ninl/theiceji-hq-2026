import '@theiceji/hq-assets/register'
import { requireUser } from '@theiceji/hq-auth'
import { userActor } from '@theiceji/hq-ops/access'
import { OpsError } from '@theiceji/hq-ops/errors'
import {
  previewQuotePdf,
  quotePdfUrl,
  readQuote,
} from '@theiceji/hq-quotes/quotes'

/**
 * GET /api/quotes/<id>/pdf[?download=1] — a quote's PDF, for its owner.
 * A draft renders on the fly (dated today, marked "not sent", nothing
 * stored); a sent quote redirects to the stored PDF the client got — never
 * a re-render.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser()
  const actor = userActor({ id: user.id, role: user.role })
  const { id } = await params
  const download = new URL(request.url).searchParams.get('download') === '1'
  try {
    const quote = await readQuote(actor, id)
    if (quote.pdfAssetId && quote.status !== 'draft') {
      const stored = await quotePdfUrl(actor, id, { download, ttlSeconds: 300 })
      return Response.redirect(new URL(stored.url, request.url), 302)
    }
    const pdf = await previewQuotePdf(actor, id)
    const disposition = `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(pdf.name)}`
    return new Response(pdf.bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': disposition,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    if (error instanceof OpsError)
      return new Response(error.message, {
        status: error.code === 'not_found' ? 404 : 400,
      })
    throw error
  }
}
