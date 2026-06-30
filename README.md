# ✦ Magnet Vault ✦

A React + Vite link manager — for magnet (torrent) links and plain http(s)
links, each in their own vault — backed directly by **Supabase**
(Postgres + auto-generated REST API), deployed as a static site on
**Cloudflare Pages**. The frontend talks to Supabase straight from the
browser using the `@supabase/supabase-js` client — no custom backend server
required.

## Quick start

```bash
npm install
cp .env.example .env   # paste your Supabase URL + anon key
npm run dev             # Vite dev server on :5173
```

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** and run the contents of `supabase/schema.sql`.
   This creates the `links` (magnet links) and `http_links` (plain http/https
   links) tables, plus the Row Level Security policies that allow public
   read/insert/delete via the anon key (suitable for a single-user /
   personal vault — see the note in that file if you want to lock it down
   with Supabase Auth instead).
3. Go to **Project Settings → API** and copy the **Project URL** and
   **anon public key**.

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

These are safe to expose to the browser — they're the public anon key, and
access is controlled by the RLS policies in `supabase/schema.sql`. Never put
the `service_role` key in frontend code.

## 3. Deploy to Cloudflare Pages

**Option A — Cloudflare dashboard (Git integration)**

1. Push this repo to GitHub/GitLab.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages →
   Connect to Git**, pick the repo.
3. Build command: `npm run build`, build output directory: `dist`.
4. Under **Settings → Environment variables**, add `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY` (for both Production and Preview).
5. Deploy. SPA routing is handled by `public/_redirects`
   (`/* /index.html 200`), which Vite copies into `dist/` automatically.

**Option B — Wrangler CLI**

```bash
npm install -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=magnet-vault
```

Set the Supabase env vars for the Pages project either in the dashboard
(**Settings → Environment variables**) or via:

```bash
wrangler pages secret put VITE_SUPABASE_URL --project-name=magnet-vault
wrangler pages secret put VITE_SUPABASE_ANON_KEY --project-name=magnet-vault
```

`wrangler.toml` and `npm run deploy` (build + `wrangler pages deploy dist`)
are already wired up for the CLI flow.

## Data model

Table: `public.links` (magnet links)

| Column     | Type        |
| ---------- | ----------- |
| id         | bigint (PK) |
| title      | text        |
| magnet     | text        |
| created_at | timestamptz |

Table: `public.http_links` (plain http/https links)

| Column     | Type        |
| ---------- | ----------- |
| id         | bigint (PK) |
| title      | text        |
| url        | text        |
| created_at | timestamptz |

## HTTP links

The app has a second vault for ordinary http(s) links, kept in its own
Supabase table (`http_links`) and shown under the **HTTP Links** tab. Pasting
a blob of links into "Add all pasted" splits them automatically — including
links pasted back-to-back with no separator between them, e.g.
`https://buffer.comhttps://outlook.com` becomes two links.

## What changed vs. the Fly.io/Postgres version

- Removed the Express server (`server/index.js`) and Dockerfile/`fly.toml` —
  there's no custom backend anymore.
- The frontend now calls Supabase directly via `@supabase/supabase-js`
  (see `src/supabaseClient.ts`), instead of hitting a same-origin `/api/*`
  Express API.
- Deployment target: Cloudflare Pages (`wrangler.toml`, `public/_redirects`)
  instead of a Fly.io container.
- Database: Supabase Postgres (with RLS policies) instead of Fly Postgres /
  plain `pg`.

## What changed vs. the Netlify version

- Deployment target is now Cloudflare Pages instead of Netlify — `netlify.toml`
  has been removed and replaced with `wrangler.toml` (CLI deploys) and
  `public/_redirects` (SPA routing, equivalent to Netlify's old `/* -> /index.html`
  rule).
- Added a second link vault for plain http(s) links, backed by a new
  `http_links` Supabase table (see "HTTP links" above).
- Ocean Mermaid visual theme (teal/azure/gold palette, bubble/shell/fish
  background ornaments) in place of the previous rose/violet theme.

