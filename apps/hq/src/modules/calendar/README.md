# Calendar

HQ's events, synced two ways with the owner's Google Calendar, with the dates
other modules own drawn over them.

- Routes: `/p/<slug>/calendar` and `/calendar` (week · month).
- Instrument: the sync readout (an LCD chip in the toolbar) and the `--wait`
  now line in today.
- Keys: `e` add · `↵` edit · `⌫` delete · `g` sync now · `t` today · `[` `]`
  previous / next.
- Delete: an event that syncs asks first, in place (the shared `Confirm`) —
  `⌫` opens the same question as the button. Every delete's toast has
  Undo (`restoreEvent`), which works until the next sync has taken the
  event off Google; after that Undo says so in words.

| Part | File | Data owner |
| --- | --- | --- |
| Page (week, month, inspector, overlay) | `components/CalendarPage.tsx` · `calendar.css` | hq-calendar |
| Server reads | `load.ts` (`loadCalendar`: the range in the project's timezone, the sync status, the overlay) | hq-calendar · hq-board (`listCards`) · hq-quotes (`listQuotes`) |
| Records to the page | `data.ts` (`eventData`, `statusData`, `OverlayData`) | — |
| Writes | `actions.ts` (create, update, delete, Delete's Undo, retry sync, sync now) | hq-calendar |
| Sync | `calendar.sync` tick step (`packages/hq-calendar/src/register.ts`), run by `/api/cron/ops-tick` and the MCP server's loop | hq-calendar · hq-core (`google_connections`) |
| MCP | `apps/hq-mcp/src/modules/calendar` (`calendar_list_events`, `calendar_create_event`) | hq-calendar |

Rules the page keeps:

- The overlay (card dues, quotes running out) is read from its own modules
  and never stored or synced here.
- All-day events are stored as midnight UTC and shown as dates, never shifted
  by a timezone.
- Without a Google connection the sync chip says so and links to
  Settings › Google; events stay in HQ.
