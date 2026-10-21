# Quotes

Quotations `Q-YYYY-NNN` with Thai VAT (7 %) and withholding (3 %), a Thai PDF
frozen into Assets when sent, and a link to the board card they price.

- Routes: `/p/<slug>/quotes` and `/quotes`, one view. Clients live on HQ-wide
  `/clients`, in the rail; the old `?view=clients` redirects there.
- Instrument: the totals tape — subtotal · VAT · withholding · total due on an
  LCD, the THB total in Thai words under it.
- Keys: `c` new quote · `p` preview PDF · `s` mark sent · `⌫` delete draft ·
  `a` accepted · `x` declined · `r` revise · `d` download PDF · `↑ ↓` quotes.

| Part | File | Data owner |
| --- | --- | --- |
| Page (table, draft editor, sent reader, issuer) | `components/QuotesPage.tsx` · `quotes.css` | hq-quotes |
| Server reads | `load.ts` (`loadQuotes`; `?quote=` loads the detail on the server; `?new=1&card=` or `&client=` picks the client) | hq-quotes · hq-core (clients) |
| Records to the page | `data.ts` (`quoteRowData`, `quoteDetailData`, `clientData`) | — |
| Writes | `actions.ts` (draft, update, send, decide, revise, delete draft, issuer) — clients are written on `/clients` (`modules/clients`) | hq-quotes · hq-core (`owner_settings.quoteIssuer`) |
| PDF | `app/api/quotes/[id]/pdf/route.ts` — a draft renders a preview; a sent quote redirects to its frozen asset | hq-quotes (`pdf.ts`, PDFKit + vendored IBM Plex Sans Thai) → hq-assets |
| MCP | `apps/hq-mcp/src/modules/quotes` (`quotes_list`, `quotes_draft`) | hq-quotes |

Rules the page keeps:

- Money is decimal strings with bigint minor units (`hq-core/money`), never floats.
- Mark sent freezes the lines, the totals snapshot and the PDF (database
  triggers refuse changes after). HQ never emails a client.
- Mark sent, Accepted and Declined can't be taken back, so each asks once, in
  place (`components/Confirm.tsx` with `again`): the key or the button asks,
  the same key again (or ↵, or the answer) does it; Esc, moving away or a few
  seconds without an answer take the question back.
- Quotes never reads Board's tables: "Quote this card" passes the card's id,
  title and price, and the quote links `card —quoted_by→ quote`.
- On Home a sent quote whose card is awaiting payment, done or paid counts
  once, as the card (`lib/home.ts`).
- Next.js bundles `pdf.ts`, so the font folder is found from the working
  directory there; `next.config.ts` traces `packages/hq-quotes/fonts` in.
