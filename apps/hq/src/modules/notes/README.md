# Notes

Parked thoughts that belong to all of HQ, and Promote: a note becomes a card,
a prompt or an event (a shot, for a film, once Story lands) and stays linked
to it. Plain on purpose: no instrument.

- Route: `/notes` — Board (a pool of cards) · List, plus Archive and Trash,
  which keep what the older board put away, each with Restore.
  `?note=<id>` selects; `?open=<id>` is the same, from Share to Notes;
  `?new=1` (the PWA's "Jot a note", `NOTE_CAPTURE_HREF`) opens New note and
  leaves the URL.
- Keys: `↵` capture · `c` new note · `p` promote · `e` edit · `⌫` delete
  (Undo) · `r` restore in Archive/Trash · `⌫` delete for good in Trash
  (asks first) · `↑ ↓` notes · `/` capture field.
- Trash: Delete for good per note, and Empty trash in the toolbar — both
  ask first, in place (the shared `Confirm`), because neither comes back.
- New note: the Board's first place is a dashed tile (`.pcard.ghost`) that
  opens the shared `Modal` — title, note, filed under — like Keep's "Take a
  note". ⌘↵ saves; ↵ in the title moves to the note.
- A card shows the title on its own line, then the body through the shared
  markdown (`lib/md.tsx`), cut by `excerpt` and with every typed line kept by
  `keepLines` (`lib/notes/types.ts`); the inspector uses `keepLines` too.

| Part | File | Data owner |
| --- | --- | --- |
| Page (capture, New note modal, filter, pool/table, inspector, promote form) | `components/NotesPage.tsx` · `notes.css` | `lib/notes` |
| Server reads | `load.ts` (`loadNotes`: the view's bucket, the projects, what each can take) | `lib/notes/store.ts` · hq-core |
| Writes | `actions.ts` (capture, edit, file under a project, archive, trash, promote, unlink, delete for good, empty trash) | `lib/notes` |
| Promote | `lib/notes/promote.ts` — one transaction: the target's adapter creates the record, `refs note —promoted_to→ record`, the note records where it went | hq-core `targets.ts` + each module's `register.ts` |
| Share target | `app/(app)/notes/share/page.tsx` (redirects to `/notes?open=`; its fallback page is still legacy) | `lib/notes` |

Rules the page keeps:

- No agent reads a note unless it is promoted.
- The trash empties itself after 30 days, swept when the page loads.
- Promote's targets are listed in the spec's order (card · prompt · shot ·
  event), whichever module registered first.
