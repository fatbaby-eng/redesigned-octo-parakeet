# Mr. Todd's Woodcrafts — Migration Patch Delivery

This branch is a one-off delivery channel because the Claude Code session
that produced the migration commit could not push directly to
`fatbaby-eng/mr-todds-woodcrafts` — its git proxy was scoped only to
`fatbaby-eng/redesigned-octo-parakeet`.

The commit is included as `woodcrafts-migration.patch` (a single
`git format-patch` against the initial Manus export, sha `17d13c3`).

## What's in the patch

A single commit titled:

> Migrate off Manus runtime: Render + TiDB + Stripe Checkout

It strips the Manus runtime (Vite plugins, debug collector, OAuth, Forge
data/storage/llm/etc.), replaces the auth path with a password-gated admin
session (jose HS256 cookie), stubs `notifyOwner` and `storagePut`, rewrites
product seed image paths to `/products/*.jpg`, adds Stripe Checkout
(tRPC mutation + raw-body webhook handler), and adds a `render.yaml` for
the Render web service.

## How to apply

```bash
# 1. Clone your repo (if you don't already have it locally)
git clone https://github.com/fatbaby-eng/mr-todds-woodcrafts.git
cd mr-todds-woodcrafts

# 2. Make a branch from the Manus-export initial commit
git checkout -b claude/migrate-woodcrafts-render-0KbNB

# 3. Download the patch from this delivery branch
curl -L -o /tmp/woodcrafts-migration.patch \
  https://raw.githubusercontent.com/fatbaby-eng/redesigned-octo-parakeet/delivery/woodcrafts-migration-patch/woodcrafts-migration.patch

# 4. Apply it
git am /tmp/woodcrafts-migration.patch

# 5. Push
git push -u origin claude/migrate-woodcrafts-render-0KbNB
```

After it lands you can delete this delivery branch on
`redesigned-octo-parakeet` — it has no relationship to that project's
history (orphan branch, no shared commits).
