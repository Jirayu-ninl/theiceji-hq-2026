# Experiments

One question, asked once, read at one age: variants, items (posts or
listings that went out), decisions (append-only) and learnings.

- Routes: `/p/<slug>/experiments` (experiments · learnings).
  `?experiment=<id>` selects; `?q=` searches learnings.
- Instrument: the strip plot — an LCD with one row per variant on a shared
  scale; a dot per item at its value at the age, the observed middle as a
  taller tick, too-young items hollow and parked with "in 20h", not-read
  items as dashed rings. Never an average, never a zero for "no reading".
- Keys: `c` new · `e` edit design · `s` start · `a` add an item · `p` stop
  adding — read · `d` decide · `l` learning · `⌫` delete a draft (asks) ·
  `/` search learnings · `↑ ↓` experiments.

| Part | File | Data owner |
| --- | --- | --- |
| Page (list, detail + strip plot, design · decide · learning forms, learnings) | `components/ExperimentsPage.tsx` · `experiments.css` | hq-experiments |
| Server reads | `load.ts` (`loadExperiments`; subjects that went out, through the readings subject providers) | hq-experiments · hq-core readings |
| Records to the page | `data.ts` (`experimentData`, `ageReadingData` — shared with Publish and Readings) | — |
| Writes | `actions.ts` | hq-experiments |
| MCP | `apps/hq-mcp/src/modules/experiments` (`experiments_list`, `_save`, `_transition`, `_record_decision`, `_record_learning`, `_search_learnings`) | hq-experiments |

Rules the page keeps:

- Start freezes the design; deciding is the owner's and freezes the readings
  at the age into the decision. The leader is words, never a decision.
- Items link `post|listing —attached→ experiment` through `refs`.
- Removal: only a draft is deleted — for good, asked in
  place, with its variants, items and links; a learning recorded on it stays,
  unlinked. Anything that started is archived (asked too: nothing moves an
  archived experiment back), and says why where Delete would be. The
  database refuses to archive a draft, so a draft is never offered Archive.
