# Clients

Who the work is for, across every project: one HQ-wide record per client
that Board cards (the Client field) and Quotes (bill-to) both point at.
Not a module of any project — it sits
in the rail's top group between Projects and Data.

- Route: `/clients` — Active · Archived (`?view=archived`, keys `1 2`);
  `?client=<id>` selects. Table + Inspector (400), a sheet at ≤ 1100.
- Instrument: the ledger strip — paid this year, awaiting payment and on the
  board as one bar on one scale (paid lit, awaiting as unlit segments under
  a dashed accent cap, on the board a dashed outline), with a line each.
- Keys: `c` new client · `e` edit · `b` card for this client · `⌫` delete
  (asks first) · `r` restore (Archived) · `↑ ↓` `j` `k` clients · `Esc`
  close.

| Part | File | Data owner |
| --- | --- | --- |
| Page (toolbar, awaiting readout, table, names used once, inspector, ledger strip, card rows, quotes, form) | `components/ClientsPage.tsx` · `clients.css` | hq-core · hq-board |
| Server reads | `load.ts` (`loadClients`: clients, `clientLedger`, projects, one-time names from active cards, `clientUses` — what points at each client; `loadClientDetail`: the client's cards with follow-ups and payments, and their quotes) | hq-core (`clients.ts`) · hq-board (`clientLedger`, `listCards`, `listCardExtras`) · hq-quotes (`listQuotes`) |
| Records to the page | `data.ts` (`clientData`, `ledgerData`, `onceNames`, `detailData`) | — |
| Writes | `actions.ts` (detail read, save, archive/restore, delete for good, Add as client + its Undo) | hq-core (`createClient`, `updateClient`, `setClientArchived`, `deleteClient`) · hq-board (`updateCard`) |

Rules the page keeps:

- Every baht counts once, by `clientLedger`: a card's money is its total
  (price + follow-ups); what came in (deposits, part payments, finals) is
  paid on the day it came in; what is left is awaiting (in an
  awaiting-payment lane) or on the board. Quotes stay out — a quoted card
  holds that money. Currencies are never converted: the strip is drawn in
  THB (else the first currency) and names the others in words.
- A name typed once on a card is not a client. "Add as client"
  makes the record and points those cards at it, each with its own revision
  check; when an active client already has the name, the cards link to it.
  Undo puts the name back on the cards and archives a client it made.
- Archive hides a client from the pickers and never deletes it — cards and
  quotes keep its name. Archive and restore are the owner's.
- Delete is for a client nothing points at (no card in any state — archived
  and in the Trash too — and no quote): gone for good, so it asks first, in
  place, and it is the owner's. A client in use says why where the button
  would be: archive it instead.
- "＋ Card for this client" opens `/p/<slug>/board?newFor=<id>` when the
  client works in exactly one project with Board on, else `/board?newFor=<id>`.
  "＋ Quote" opens `/quotes?new=1&client=<id>`.
