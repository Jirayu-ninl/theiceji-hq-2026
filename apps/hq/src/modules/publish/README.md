# Publish

A channel's accounts and the posts that leave through them: planned →
scheduled (the owner cleared exactly this payload, for 24 hours) →
dispatched → posted → verified, or removed · failed.

- Routes: `/p/<slug>/publish` (posts · accounts). `?post=<id>` selects,
  `?new=1` opens the new-post form.
- Instrument: the age ruler — views at 1h · 24h · 72h · 7d on an LCD line,
  lit where a reading exists near that age, dashed where the age passed
  without one, dim where it hasn't come, with the post's age now as the
  playhead. A gap is words, never a 0.
- Keys: `c` new post (account) · `a` clear to post · `e` edit · `⌫` delete
  (planned) · `r` record as posted · `p` post now · `u` take back ·
  `v` record reading · `x` mark removed · `↑ ↓` posts.

| Part | File | Data owner |
| --- | --- | --- |
| Page (posts table + readouts, post inspector, post form, accounts) | `components/PublishPage.tsx` · `publish.css` | hq-publish |
| Server reads | `load.ts` (`loadPublish`; `viewsAtAges` reads views at the ruler's ages through the `post` subject provider) | hq-publish · hq-core readings |
| Records to the page | `data.ts` (`accountData`, `postRowData`, `postDetailData`) | — |
| Writes | `actions.ts` (plan, update, clear, take back, delete, record posted, dispatch, remove, readings, accounts) | hq-publish |
| MCP | `apps/hq-mcp/src/modules/publish` (`publish_list_posts`, `_prepare`, `_dispatch`, `_record_manual`, `_record_reading`, `_cancel`) | hq-publish |

Rules the page keeps:

- Clear to post is the one red button: it issues a release authorization for
  exactly this payload. Editing a cleared post takes the clearance back.
- Clear to post and Post now each ask once, in place (`components/Confirm.tsx`
  with `again`): the key or the button asks, the same key again (or ↵, or the
  answer) does it; Esc, moving away or a few seconds without an answer take
  the question back. Deleting a planned post asks once too — it can't come
  back.
- Post now needs an account whose platform HQ can post to and a live
  connection (Settings › Connections); otherwise the owner posts by hand and
  records it with their word.
- Readings are append-only; a new value for the same moment corrects the old
  one. An earnings span is held inside [posted at, now].
