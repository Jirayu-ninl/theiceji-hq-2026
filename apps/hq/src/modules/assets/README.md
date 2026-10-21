# Assets

Every file HQ keeps — uploads, generated results, quote PDFs — in the
project's storage (R2 or Google Drive).

- Routes: `/p/<slug>/assets` (grid · list · collections) and `/assets`.
- Instrument: the viewer strip — timecode, size and bytes; a filmstrip for video.
- Keys: `u` upload · `d` download · `e` rename (the title) · `t` tag · `k`
  collection · `x` reject a pending upload · `⌫` delete (asks) · `↑ ↓` assets.
  In Collections a click or `↵` opens one (the Grid filtered to it,
  `?collection=<id>`); `↑ ↓` / `␣` pick one for the inspector, `e` rename ·
  `⌫` delete (asks). Nothing is picked when the page opens, so the inspector
  stays out of the way until you pick a file.

| Part | File | Data owner |
| --- | --- | --- |
| Page (pool, dropzone, inspector, collections) | `components/AssetsPage.tsx` · `assets.css` | hq-assets |
| Server reads | `load.ts` (`loadProjectAssets`, `loadAllAssets`) | hq-assets |
| Records to the page | `data.ts` (`assetData`, `collectionData`) | — |
| Writes | `actions.ts` (prepare → browser PUT → finalize, thumbnail, title, tags, collections — make, file, rename, delete — reject, delete, access URL) | hq-assets · hq-storage |
| Drive content | `app/api/assets/content/route.ts` — streams a Drive file for a sealed, short-lived token | hq-assets |
| MCP | `apps/hq-mcp/src/modules/assets` (`assets_list`, `assets_prepare_upload`, `assets_finalize`, `assets_get_access`, `assets_get_job`, `assets_record_generated` — the last two for generation jobs, Phase 4) | hq-assets |

Rules the page keeps:

- An upload is `pending` until finalize has checked the bytes (size, sha256);
  `ready` freezes the file's identity by a database trigger. Its title is not
  part of it: Rename sets `title` over `name`, which stays the file name as
  uploaded — what a download saves as, and what leaves HQ.
- Downloads use a short-lived access URL, never the bucket path. HQ never
  changes Drive sharing; a Drive file streams through HQ's own route.
- Removal is the owner's and asks in place: deleting an
  asset takes its bytes; deleting a collection takes only the grouping —
  every file stays. A `generated` collection (HQ files generations and sent
  quotes' PDFs into it by name) keeps its name and stays, and says so.
- On `/assets` a file needs a project: the drop tile and Upload ask for one
  before any file is picked.
- A video's still is grabbed in the browser while it uploads; the worker job
  `assets.thumbnail` takes over when `apps/worker` moves onto module tools.
