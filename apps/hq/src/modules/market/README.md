# Market

Digital assets for sale: shops (marketplaces), products (files from Assets:
deliverable · preview), listings (a product on one shop: planned → approved
→ dispatched → listed → verified · inactive · failed), money lines and
payouts.

- Routes: `/p/<slug>/market` (listings · products · money).
  `?listing=<id>` and `?product=<id>` select.
- Instrument: the net tape — price · each fee from the owner's fee sheet ·
  what reaches you (an estimate, dashed), with the recorded 7-day truth from
  the money lines under a rule.
- Keys: listings `l` list a product · `a` approve · `e` edit · `⌫` delete
  (planned) · `r` record listed · `p` send · `u` take back · `s` record sale;
  products `c` new product; money `s` record a line.

| Part | File | Data owner |
| --- | --- | --- |
| Page (listings + tape, products pool, money lines, payouts, shop form) | `components/MarketPage.tsx` · `market.css` | hq-market |
| Server reads | `load.ts` (`loadMarket`; previews of product preview files) | hq-market · hq-assets |
| Records to the page | `data.ts` | — |
| Writes | `actions.ts` (shops, sync, products + files, listings, approve, record listed, dispatch, sales, payouts) | hq-market |
| MCP | `apps/hq-mcp/src/modules/market` (`market_list_listings`, `_prepare`, `_dispatch`, `_record_manual`, `_record_sale`, `_record_payout`) | hq-market |

Rules the page keeps:

- Approve is the one red button (a release authorization for exactly this
  payload). Changing a product's files or a shop after approval takes it back.
- Approve and Send each ask once, in place (`components/Confirm.tsx` with
  `again`): the key or the button asks, the same key again (or ↵, or the
  answer) does it; Esc, moving away or a few seconds without an answer take
  the question back. Deleting a planned listing asks once too.
- Money is decimal strings per currency, never converted or summed across
  currencies. Lines are append-only; a mistake gets a correction that
  strikes the old line.
- Send needs an Etsy shop with a live connection; every other shop is by
  hand — put it up yourself and record it.
