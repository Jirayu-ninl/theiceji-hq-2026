# Board

Cards in lanes, with a price that becomes pending money in **Awaiting payment**
and income as it comes in.

- Routes: `/p/<slug>/board` (lanes · table · archived · trash) and `/board`
  (every project's cards: table · archived · trash — lanes need one project).
  `?view=archived` / `?view=trash` list those cards with Restore `r`.
  `?newFor=<clientId>` opens New card with that client (from `/clients`).
- Instrument: the lane footer — the sum of the lane's totals on an LCD; in
  Awaiting payment, what is still owed, with what already came in under it.
- Keys: `c` new card · `[` `]` move one lane · `m` mark paid · `e` edit ·
  `f` follow-up · `r` record a payment · `p` link a prompt · `y` copy it ·
  `u` add files · `⌫` delete (to the Trash) · `↑ ↓` cards · `← →` lanes (Lanes
  view only). With a lane open (click its head): `e` rename · `[` `]` move
  it · `⌫` delete it (asks) · `c` a card in it. Archived and Trash: `r`
  restore, `⌫` delete (Archived). Drag and drop moves between lanes too; a
  faint dashed slot shows where the card will land.

| Part | File | Data owner |
| --- | --- | --- |
| Page (lanes, table, inspector, history, drop slot) | `components/BoardPage.tsx` · `board.css` | hq-board |
| Inspector sections (follow-ups, payments, prompt, files, pay meter) | `components/CardParts.tsx` · `components/PromptPicker.tsx` | hq-board · hq-prompts · hq-assets |
| Shared fields | `@/components/ClientPicker.tsx` (combobox + New client modal + use once) · `@/components/Swatches.tsx` · `@/components/Modal.tsx` | hq-core (`clients.ts`) |
| Server reads | `load.ts` (`loadProjectBoard`, `loadAllBoards`: cards with `listCardExtras`, clients, the project's modules) | hq-board `listCards`, `boardSummaries`, `listCardExtras` · hq-core `listClients` |
| Records to the page | `data.ts` (`cardData`, `laneData`, follow-ups, payments, client options) | — |
| Writes | `actions.ts` (create, update, move, mark paid / unpaid, archive, delete / restore, lanes: add · rename · move · delete, history; follow-ups; payments + void; new client; prompt pick / create / link; file attach; unlink) | hq-board (`board.ts`, `followups.ts`, `payments.ts`, `links.ts`) · hq-core · hq-prompts |
| Uploads | `modules/assets/upload.ts` (`put`, `measure`, shared with Assets) | hq-assets · hq-storage |
| MCP | `apps/hq-mcp/src/modules/board` (`board_list_cards`, `board_create_card`, `board_update_card`, `board_move_card`, `board_add_followup`, `board_update_followup`) | hq-board |

Rules the page keeps:

- Moves go through a write queue with the card's latest revision, so a burst
  of `]]]` never reads a stale revision.
- A card's **total** is its price plus its live follow-ups; **paid** is what
  came in (deposit · part payments · final); **owed** is total − paid. The
  tile and the Awaiting lane show owed; nothing is income until it came in.
- Payments are an append-only ledger (`board_card_payments`). A deposit is
  any amount or none. Undo and removing a payment void it with a new line;
  nothing is edited or deleted.
- Mark paid records the rest as a `final` line, sets `paid_at` and archives
  the card in one step; its Undo ("unpaid") voids that final line.
- Delete sends a card to the Trash: archived + `deleted_at`,
  history and payment lines kept; Restore puts it back where Delete found it
  (its lane's end, or Archived). A card with money in — or marked paid —
  can't be deleted; the inspector says why where Delete would be. MCP never
  sees the Trash.
- Lanes are the owner's: add (`＋ Lane`, lands before Awaiting payment),
  rename, move, delete. A lane with live cards, Awaiting payment and the last
  lane to work in can't be deleted; a deleted lane's archived and trashed
  cards move to the first lane. Only the lanes you work in scroll; Awaiting
  payment sits beside them, pinned right, never over one.
- Follow-ups are work that came after the card's task (not sub-tasks): title,
  details, price, due, prompt, files. They can be added while the card waits
  for payment; everything freezes once it is paid.
- The job's due is the nearest upcoming due across the card and its
  follow-ups; it reads late only once all of them have passed.
- The colour is a 3px stripe on the tile's left (`::after`); the tile's
  background never changes. The client's name sits faint above the title.
- One prompt per card or follow-up (`card —made_with→ prompt`). A new prompt
  from a project without Prompts goes to the library.
- A card links to the quote it was priced in (`card —quoted_by→ quote`), the
  note it came from and its files; the inspector shows them from `refs`.
