# Contributing

## Local setup

```bash
npm ci
```

## Run locally

```bash
npm run dev            # wrangler dev
npm run migrate:local  # apply D1 migrations to the local database
```

## Tests and checks

Run the same checks CI runs before opening a PR:

```bash
npm run typecheck
npm run lint            # prettier --check; use `npm run format` to fix
npm run test
npx wrangler deploy --dry-run   # validates wrangler.jsonc without deploying
```

## CI/CD

- **`.github/workflows/ci.yml`** runs on every pull request and on pushes to
  any branch other than `main`: install, typecheck, lint, test, and a
  `wrangler deploy --dry-run` config check. It needs no Cloudflare
  credentials.
- **`.github/workflows/deploy.yml`** runs only on pushes to `main` (and via
  manual dispatch): it repeats the same checks, applies D1 migrations with
  `wrangler d1 migrations apply fantasy --remote`, then deploys with
  `cloudflare/wrangler-action`. It uses the repo secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## First-time deploy

`wrangler.jsonc` ships with a placeholder `database_id` for the `fantasy`
D1 database. Before `deploy.yml` can run successfully, create the real
database (`npx wrangler d1 create fantasy`) and replace
`REPLACE_WITH_D1_ID` with the id it prints.

## Secrets

This repo is **public**. The fantasy site credentials
(`FANTASY_EMAIL`, `FANTASY_PASSWORD`, `FANTASY_SESSION_COOKIE`) must
**never** be committed, put in a workflow file, or set through CI. They are
set once, by hand, directly against the deployed Worker:

```bash
npx wrangler secret put FANTASY_EMAIL
npx wrangler secret put FANTASY_PASSWORD
npx wrangler secret put FANTASY_SESSION_COOKIE
```

Only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in GitHub
(as repository secrets, used by `deploy.yml` to authenticate `wrangler`
itself) — never the fantasy site credentials above.
