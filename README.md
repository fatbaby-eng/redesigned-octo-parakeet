# tb-atlas

Personal project management dashboard for Todd Boswell. Cloudflare Worker + D1 + Static Assets.

## URLs
- Workers.dev: https://tb-atlas.fatbaby-2ba.workers.dev/atlas/
- Custom: https://www.toddboswell.com/atlas/

## Layout
```
.
├── wrangler.toml      # uses [assets] (NOT [site]) and binds env.ASSETS
├── worker.js          # Worker entry: API + serveStatic
├── schema.sql         # D1 schema
└── public/            # Static assets served via env.ASSETS
    ├── index.html
    ├── app.js
    ├── styles.css
    └── favicon.svg
```

## What was wrong before
1. `wrangler.toml` was using the legacy `[site]` binding. The Worker code referenced `env.ASSETS`, which only exists with the new `[assets]` binding. With `[site]`, `env.ASSETS` was `undefined` and the old `serveStatic` silently fell back to `Atlas app - asset "..."`.
2. `serveStatic` wrapped the asset fetch in a try/catch that returned the misleading fallback text on any error, hiding the real cause.

## Fixes in this version
- `wrangler.toml` uses `[assets]` with an explicit `binding = "ASSETS"` so `env.ASSETS` is wired up.
- `serveStatic` no longer hides errors. If `env.ASSETS` is missing, it returns a 500 with a clear message. If the asset fetch throws, it propagates instead of returning a stub.
- `compatibility_date` bumped to a date that supports the new assets binding.

## Deploy

From the project root:

```powershell
# 1. Install wrangler if you haven't (or use npx)
npm install --save-dev wrangler

# 2. Apply the D1 schema (idempotent; safe to re-run)
npx wrangler d1 execute tb-atlas --remote --file=./schema.sql

# 3. Set the Anthropic API key (only needed for /reflect and /agent)
npx wrangler secret put ANTHROPIC_API_KEY

# 4. Deploy
npx wrangler deploy
```

In the deploy output you should see a sync step listing your asset files:
```
Done syncing assets
 = index.html
 = app.js
 = styles.css
 = favicon.svg
```

If you only see `Skipped uploading N existing assets` and no sync line, the
`[assets]` block isn't being read. Confirm the file content matches
`wrangler.toml` in this repo and that you're deploying from this directory.

## Verify

```powershell
# Confirm tables exist
npx wrangler d1 execute tb-atlas --remote --command "SELECT name FROM sqlite_master WHERE type='table';"

# Hit the API
curl https://tb-atlas.fatbaby-2ba.workers.dev/atlas/api/projects

# Open the UI
start https://tb-atlas.fatbaby-2ba.workers.dev/atlas/
```

The UI page should render the dashboard, not the text `Atlas app - asset "/index.html"`.

## Local dev

```powershell
npx wrangler dev
```

Then visit `http://localhost:8787/atlas/`.

## API

| Method | Path                                | Notes                          |
|--------|-------------------------------------|--------------------------------|
| GET    | `/atlas/api/projects`               | List                           |
| POST   | `/atlas/api/projects`               | Create                         |
| GET    | `/atlas/api/projects/:id`           | Detail with log + reflections  |
| PUT    | `/atlas/api/projects/:id`           | Patch                          |
| DELETE | `/atlas/api/projects/:id`           | Delete                         |
| POST   | `/atlas/api/projects/:id/log`       | Append log entry               |
| POST   | `/atlas/api/reflect`                | Claude reflection (needs key)  |
| POST   | `/atlas/api/agent`                  | Claude agent (needs key)       |
