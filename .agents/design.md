# Dashboard design rules (`src/dashboard.ts`)

The dashboard is server-rendered HTML in template strings, no framework, no client JavaScript, no external assets. It is a dark path for the factory, so keep it simple and safe.

- Escaping: every interpolated value goes through `escapeHtml(value)`. Player names, injury news, LLM reasoning and error text are untrusted free text. Add a test with `<script>` in the value for any new cell.
- Links: build with `pageLink(path, params, token)` so the `?token=` is preserved and the result is escaped. Never hand-concatenate URLs.
- Responses: `new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })`, only after `isAuthorized`; otherwise `notFound()`.
- Page shell: `<!doctype html>`, `<title>`, charset and viewport metas, `<style>${STYLE}</style>`, one `<h1>`, sections as `<h2>` plus a table or `<p>` empty state ("None yet.", "No squad on record yet.").
- Styles: extend the single `STYLE` constant. System font, `.badges span` pills for status, `.ok` green and `.bad` red for state, `.tag`, `.tag.gate` (amber) and `.tag.err` (red) for labels, `details`/`summary` for drill-down, `.detail` for wide cells.
- Tables: `<thead>` with `<th>`, compact rows, `.grp` rows for groups. Render structured JSON as readable sub-tables, never raw `{}`; use `hasContent` to treat empty values as absent.
- Numbers: format with `toFixed` for xPts; show `-` for missing values; show `unknown` for an unset value rather than hiding the field.
- No secrets on the page: never the cookie, only its fingerprint.
- Every new section needs a test in `test/dashboard.test.ts` covering populated, empty and hostile-text cases.
