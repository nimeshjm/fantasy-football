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
npx wrangler secret put FANTASY_EMAIL           # password provider only
npx wrangler secret put FANTASY_PASSWORD        # password provider only
npx wrangler secret put FANTASY_SESSION_COOKIE  # manual provider (current)
npx wrangler secret put DASHBOARD_TOKEN         # gates GET / and the admin routes
npx wrangler secret put ALERT_WEBHOOK_URL       # optional; must be https
```

`ALERT_WEBHOOK_URL` is where a dead-session alert is POSTed. Leaving it
unset is supported and means alerting is simply off — useful locally, and
why CI needs no stub. It must be `https:`; a plaintext URL is refused rather
than downgraded silently.

A Discord webhook (Server Settings → Integrations → Webhooks → New Webhook →
Copy URL) or a Slack incoming webhook both work as-is: the body carries the
one-line summary under both `content` and `text`, which is the field each of
them renders. The URL *is* the credential, so it belongs in
`wrangler secret put`, never in `wrangler.jsonc` — this repo is public.

Prefer a channel that keeps a backlog over a transient desktop banner. The
alert fires **at most once per incident** (see `config.session_alert_open`),
so a notification missed while the machine was asleep is not repeated until
the session recovers and dies again.

Only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in GitHub
(as repository secrets, used by `deploy.yml` to authenticate `wrangler`
itself) — never the secrets above.

## Rotating the session cookie

`SESSION_PROVIDER` is `manual`: the site rejects `POST player/login/` for
this account, so the `sessionid` is pasted in and cannot re-authenticate
itself. When it expires the agent keeps committing a legal team but stops
reading the Portuguese injury text, so the rotation is not optional.

1. Log in to the site in a browser, open the cookie inspector, and copy the
   `sessionid` value.
2. **Write down its `expires` attribute.** Nothing in the Worker can see it —
   the cookie arrives as a bare secret — and it is the only direct read on
   the real lifetime.
3. `npx wrangler secret put FANTASY_SESSION_COOKIE` (a bare value or a full
   `sessionid=...` header both work).
4. Within the hour the next tick stamps `session.first_ok_at` and a new
   `session.cookie_fingerprint`. The dashboard's Cookie badge then counts up
   from that paste.

The dashboard's cookie age is a **lower bound** until at least one full
expiry cycle has been observed: `first_ok_at` is stamped at the first healthy
tick, not at paste time, so a cookie that was already in place reads as
younger than it is. To recover the lifetime of a cookie that has already been
replaced, query the heartbeat archive — `actions_log` is never pruned and
every beat carries the fingerprint it was made with:

```sql
SELECT json_extract(response, '$.fingerprint') AS cookie,
       MIN(ts) AS first_ok, MAX(ts) AS last_ok, COUNT(*) AS beats
FROM actions_log
WHERE kind = 'session-health' AND ok = 1
GROUP BY cookie ORDER BY first_ok;
```

## Re-testing the password provider

If a Django-side password ever does get set on the account, `password`
becomes the strictly better provider — it cannot silently expire and needs no
rotation. Check without flipping the live var or redeploying:

```bash
curl -X POST "https://<worker>/admin/login-probe?token=$DASHBOARD_TOKEN"
```

It reports `configured: false` if `FANTASY_EMAIL`/`FANTASY_PASSWORD` are not
both set (a prerequisite, not a result), the site's own `fieldErrors` on a
rejection, and a fingerprint — never the cookie — on success. It is
rate-limited to one call a minute: repeated failed logins are an
account-lockout vector. It never writes the session row.
