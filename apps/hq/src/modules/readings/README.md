# Readings

The dashboard. It owns no records; it reads the other modules through the
hq-core readings registry (subject providers + money sources).

- Routes: `/p/<slug>/readings` (one project, Readings on), `/dashboard`
  (every live project); `/p/<slug>/dashboard` redirects. `?days=7|30|90`,
  `?age=24|72|168`, `?view=items`.
- Instrument: the VU rack — one VU per project in its colour on one shared
  scale per currency; fill = net this window, tick = the window before.
- Keys: `[` `]` window · `w` next window · `g` age · `1 2` money · posts &
  listings.

| Part | File | Data owner |
| --- | --- | --- |
| Page (toolbar readouts, rack, money lines, cost, posts & listings) | `components/DashboardPage.tsx` · `readings.css` | hq-readings |
| Server reads | `load.ts` (`loadDashboard`) | hq-readings |
| MCP | `apps/hq-mcp/src/modules/readings` (`readings_query`) | hq-readings |

Rules the page keeps:

- Money that happened, per currency, never converted: sales · refunds ·
  fees · earnings · paid → net. Pending money is Home's.
- Posts and listings are compared at the same age; younger ones are too
  young, not zero. Cost arrives with Agents (Phase 5): unknown cost is
  counted, never guessed.
