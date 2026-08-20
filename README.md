# TechnoVIT Worker

Cloudflare Worker that backs the [TechnoVIT CMS](https://github.com/technovit26/cms):
event data (D1) and media storage (R2), served behind one HTTP API.

## What it does

- Serves uploaded images/videos directly from R2 at `/images/*` and
  `/videos/*`, with HTTP range support for video streaming.
- Events API (`/events`): list, get, create, update, delete, backed by a
  D1 `events` table. Deleting an event moves its row to `deleted_events`
  instead of destroying it, so it can be restored.
- Activity Log API (`/activity-logs`): every create/update/delete/restore
  on an event is recorded with the actor who made it and what changed.
  Deletions can be undone via `/activity-logs/:id/undo`, which moves the
  row back from `deleted_events` into `events`.
- Media API (`/media`): list uploaded files, upload a new file (auto-sorted
  into `images/photos/` or `videos/`, key-prefixed with a UUID), delete a
  file.

## Stack

- Cloudflare Workers (TypeScript)
- D1 (SQLite) for event data
- R2 for image/video storage

## Getting started

```bash
bun install
bun run dev      # wrangler dev
bun run deploy   # wrangler deploy
```

`wrangler.toml` binds the `cms_assets` R2 bucket and `cms_db` D1 database.
Run `schema.sql` against the D1 database to create the `events` table.

## Migrations

Schema changes after the initial `schema.sql` live in `migrations/`,
applied in order and never re-run. Apply a new one against the remote
database with:

```bash
npx wrangler d1 execute technovit-cms-db --remote --file=migrations/0002_add_activity_log_and_deleted_events.sql
```

Drop `--remote` to apply it to your local dev database instead.

## Scripts

- `bun run dev` — local dev via `wrangler dev`
- `bun run deploy` — deploy to Cloudflare
- `bun run cf-typegen` — regenerate Cloudflare binding types
