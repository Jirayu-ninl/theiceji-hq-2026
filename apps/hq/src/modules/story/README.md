# Story

A film project's script, characters, scenes and shot board.

- Routes: `/p/<slug>/story` (script · characters · shots). `?shot=<id>`,
  `?character=<id>`, `?scene=<id>` select.
- Instrument: the shot thumbnail — pencil-on-paper while boarded, a real
  frame with its timecode once there is a result.
- Keys: script `⌘S` save · `c` new scene; characters `c` new character;
  shots `c` new shot · `g` generate still · `e` `d` edited · done ·
  `↑ ↓` shots.

| Part | File | Data owner |
| --- | --- | --- |
| Page (editor + outline, characters pool, shot board + inspector) | `components/StoryPage.tsx` · `story.css` | hq-story |
| Server reads | `load.ts` (`loadStory`; previews of results and boards) | hq-story · hq-assets |
| Records to the page | `data.ts` (`boardData`) | — |
| Writes | `actions.ts` (script, characters, scenes, shots, generate, attach, ZIP) | hq-story · hq-assets jobs |
| MCP | `apps/hq-mcp/src/modules/story` (`story_get`, `story_save_script`, `story_save_shots`) | hq-story |

Rules the page keeps:

- Generate is by hand in v1: it opens a `manual` generation job for the shot
  and its variant; the owner makes the file elsewhere and drops it here (or
  picks one already in Assets). The file links `asset —result_of→ shot`.
- A scene's ZIP is a `local_worker` job on an ops task; `apps/worker` makes
  it and the page polls until it lands. HQ never edits a film.
- Deleting a scene or a shot is the owner's.
