# Agents

The owner's routines — when an agent runs, what it reads, who runs it — their
runs with what they cost, and the proposals they leave.

- Routes: `/agents` (every routine) and `/p/<slug>/agents` (one project's).
  `?view=runs` · `?view=trash`; `?routine=<id>` selects.
- Instrument: the run strip — one column per run over the last 14 days on one
  money scale; height = cost, dashed = cost not known; ▶ running, amber ◆
  failed or stopped; the playhead at now, a ring at the next due time.
- Keys: `c` new routine · `e` edit · `r` run now · `t`/space on-off · `⌫`
  delete · `↑ ↓` move · `⌘S` save · Esc cancel. In the proposals pane (focus
  there) `a` accept · `r` reject · `h` hold. In Trash: `r` restore.

| Part | File | Data owner |
| --- | --- | --- |
| Page (routines/runs table, proposals pane, inspector, routine form) | `components/AgentsPage.tsx` · `agents.css` | hq-agents |
| Server reads | `load.ts` (`loadAgents`: routines, runs, proposals via `lib/inbox`, projects, Anthropic keys) | hq-agents · hq-core |
| Records to the page | `data.ts` (`routineData`, `runData`, `costText`) | — |
| Writes | `actions.ts` (save, on/off, run now, delete / restore, detail) · proposals through `app/(app)/inbox/actions.ts` | hq-agents |
| MCP | `apps/hq-mcp/src/modules/agents` (`agents_claim_task` … `agents_finish`, `agents_propose`, `agents_record_cost` …) | hq-ops · hq-agents |
| Builtin runner | `apps/agent-runner` (claims `claimant: builtin` routines, Claude with the owner's key) | hq-agents · hq-core |

Rules the page keeps:

- Routines are the owner's (`manage`): no connection schedules itself.
- Delete stops a routine like the old Archive — off, its
  queued run cancelled — and moves it to Trash, with Undo. Restore brings it
  back switched off; a name a live routine took meanwhile is refused in
  words. Routines archived before the Trash are listed there too.
- The tick only queues. `mcp` routines are claimed by the owner's own agent
  over MCP; `builtin` ones by `apps/agent-runner` on the owner's machine.
- Auto-accept is notes and prompt variants only (a CHECK in the database);
  cards, shots, events and experiments always wait for the owner. A
  proposal is also only auto-accepted when the policy lets that connection
  draft there and it holds the module's write scope — otherwise it waits.
- Cost is charged against the operating policy's cash budget; a run past it
  is stopped (`budget_exceeded`, task blocked) and shows "budget spent" with
  the policy's own words. Unknown cost is "—", never 0.
