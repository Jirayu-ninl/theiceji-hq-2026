# Prompts

A prompt library: each prompt has one text — a template whose variants are
filled from options — and examples: results attached from Assets, rated,
each with the options it was made with.

- Routes: `/p/<slug>/prompts` (grid · list · library · archived · trash,
  `?view=`) and `/prompts`. Variants (`?view=library`) is the library,
  HQ-wide — the same on every project.
- **Variants (2026-09-30).** `<HAIR_COLOR>` in the text (or the negative
  text) is a variant: upper case, letters, digits and `_` — `<lora:x:0.8>`
  stays text. Each option is a short key picked by name (`punk`) and the
  value that goes into the text (`black punk style with red highlight`); a
  value may be a whole block of lines. Options are the prompt's own, the
  library's (a variant with no prompt, offered by every prompt of the owner
  that writes `<NAME>`), or both — a prompt's option with a library key
  replaces it for that prompt. The rules are `@theiceji/hq-prompts/template`
  (pure, shared with the page) and `fillPrompt`.
- **Copy** puts the text in with every variant picked — never with a
  `<NAME>` left in it. Attach and Generate with… record the picks of now on
  the example.
- Until 2026-09-30 a prompt had several texts (variants A, B, C …);
  migration `0005_prompt_slots` moved each extra one into a prompt of its own
  ("title · B"), examples and links with it.
- The text is the picker: each variant is a chip in the sentence showing the value picked (or its
  name, dashed); the chip opens its options — this prompt's, then the
  library's — with ＋ Option for it last. Edit is the text, the negative text
  and the hints.
- Examples show All by default, each tagged with the keys it was made with;
  Matching narrows them to the picks of now. A click opens Made with (its
  picks, changeable · Use these picks · Take off).
- Inspector: one place each for the prompt's own actions — the prompt's ⋯ on the inspector head
  (Edit details, Archive, Delete), Copy and Edit on the text's head, ＋
  Attach as the examples' last tile (as big as an example; every example is
  a 1:1 square, cropped to cover).
- New prompt is a modal (`components/Modal.tsx`), opened by the Grid's
  dashed first tile, the toolbar, `c` or `?new=1` — as Notes' New note is.
- Keys: `c` new prompt · `y` copy (missing a pick: the focus goes to its
  chip) · `a` attach result · `e` edit text · `d` edit details · `⌫` delete
  · `/` search. In Archived and Trash: `r` restore (and `⌫` delete in
  Archived). On Variants: `c` new variant · `e` edit · `⌫` delete.

| Part | File | Data owner |
| --- | --- | --- |
| Page (pool, viewer/editor, ⋯ menus) | `components/PromptsPage.tsx` · `prompts.css` · `components/bridge/MoreMenu.tsx` | hq-prompts |
| The text and its variant chips | `components/PromptText.tsx` | hq-prompts |
| Examples (All · Matching, tags, Made with, Attach, Generate) | `components/Examples.tsx` | hq-prompts · hq-assets |
| The library (Variants view) | `components/LibraryPage.tsx` | hq-prompts |
| Shared parts (thumb, stars, filling) | `components/parts.tsx` | — |
| Server reads | `load.ts` (`loadPrompts`; `?prompt=` loads the whole prompt on the server) | hq-prompts |
| Records to the page | `data.ts` (`promptData`, `promptListData`, `librarySlotData`) | — |
| Writes | `actions.ts` (save — text and the prompt's own variants —, edit details, add / remove example, an example's picks, archive, delete / restore, example picker, the library) | hq-prompts · hq-assets (examples) |
| MCP | `apps/hq-mcp/src/modules/prompts` (`prompts_list`, `prompts_get` — with `picks`, the filled text —, `prompts_save` — `text` and `variants` by name —, `prompts_add_example` — with `picks`) | hq-prompts |

Rules the page keeps:

- An example points at a ready asset of the same owner; removing the example
  never touches the asset. Its picks are one option per variant, as many as
  are known; removing an option removes its picks.
- Saving variants matches them by id, else by name and key, so a save that
  names things (an agent's) keeps the options and the examples' picks.
- Removing: Archive puts a prompt away (Archived),
  Delete sends it to the Trash (archived too, so off every list, count and
  picker), both with Undo; Restore brings it back. MCP never sees the Trash:
  to an agent a deleted prompt reads as not found. Taking an example off
  asks in place (no Undo brings it back).
- A prompt keeps its medium and project: Edit details changes the title, what
  it's for, the collection and tags.
- A note promoted to a prompt starts with the note's text as its text
  (`lib/notes/promote.ts`); an agent's proposed text for a prompt lands as a
  prompt of its own beside it.
- Story doesn't hand a text that still writes a `<NAME>` to a generator, and
  a Board card's Copy sends you to Prompts to pick — neither keeps picks yet.
