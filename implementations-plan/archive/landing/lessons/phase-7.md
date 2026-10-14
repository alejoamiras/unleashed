# Phase 7: cutover and live verification

## The owner moves O2 to keyed runs (D17)

The owner chose to mint a token instead of clicking through O2: "I'd rather mint you a token so you
can do that please?". The lead scoped it from Cloudflare's own sources, not from memory:

- **Permission names**: the API token permissions reference (`fundamentals/api/reference/permissions`),
  and the `x-api-token-group` of each operation in `cloudflare/api-schemas` `openapi.json`, where the
  internal "Write" is the dashboard's "Edit" and "Dynamic URL Redirects" is "Single Redirect".
  - The Single Redirects entrypoint GET, rule PATCH and rule DELETE: Dynamic URL Redirects Write (GET
    also takes Read).
  - `GET /zones?name=`: Zone Read. Page Rules listing also takes Zone Read, which covers a redirect that
    turns out to be a Page Rule.
  - DNS records list: DNS Read. Certificate packs list: SSL and Certificates Read. Bot Management GET:
    Bot Management Read. Zaraz config GET: Zaraz Read.
  - Zone settings, Web Analytics' zone switch (`settings/rum`) included: Zone Settings. The schema lists
    only Zone Settings Read for `GET settings/nel`, while the generic `GET settings/{id}` takes Read or
    Write; run A reports it if Edit alone is refused.
  - Attaching a custom domain (`PUT /accounts/{id}/workers/domains`): Workers Scripts Write in the
    schema, and the Workers roles page adds Zone › Workers Routes › Write on each affected zone.
    Custom domains have no per-Worker role, so Workers Scripts Edit is account-wide.
- **The documented attach has no override for an existing DNS record.** Wrangler 4.129.1 attaches with
  `PUT /accounts/{id}/workers/scripts/{name}/domains/records`, whose body carries
  `override_existing_dns_record`, and it sets that flag without asking when stdout is not a TTY. The
  docs say a hostname with a CNAME cannot take a custom domain. Run A's DNS record decides which path
  run B needs.
- **Custom domains get their own Advanced Certificate** (custom domains docs), so run B waits for that
  pack, not the zone's Universal one, which already covers the apex and `www`.
- **Keyed runs pin a clean tree.** `env-exec` refuses a dirty tree when the owner approves, so run B's
  code waits until run A has run, and every record goes to `~/.cache`, outside the repository.

## Run A: the state before the cutover (O2 step 0)

The owner ran run A in their own session; every read succeeded. This is the rollback record (R):

- **The redirect rule**: the only rule in the zone's Single Redirects, position 1. Description "Until
  the landing page exists: apex and www go to the testnet app", ref `apex_to_testnet`, expression
  `(http.host eq "unleashed.systems") or (http.host eq "www.unleashed.systems")`, static target
  `https://testnet.app.unleashed.systems/`, status 302, query string not preserved. No Page Rules.
- **DNS**: the apex, `www`, `app` and `testnet.app` are each a proxied AAAA `100::` placeholder. No CNAME,
  so both landing hosts take the replace-the-record attach.
- **Zone settings**: Rocket Loader off; Email Obfuscation on; Web Analytics (`rum`) on; NEL on; Speed
  Brain off; Automatic HTTPS Rewrites, Server Side Excludes and Always Use HTTPS on.
- **Zaraz**: a default config with no tools. **Bot Fight Mode** and its JavaScript detections: off.
- **Workers**: `app` and `testnet.app` are custom domains of the two app Workers; no routes.
- Neither Zaraz nor Web Analytics injects anything into the testnet app's HTML today, although both
  are switched on for the zone (fetched HTML, no `cdn-cgi` or `cloudflareinsights` reference).

## Run B: the cutover

The owner ran run B in their own session at 1669839 (`bun apps/landing/scripts/cutover.ts cutover`). It
printed `CUTOVER PASSED` with no notes. The journal of every old value is
`~/.cache/unleashed-landing-cutover/cutover-2026-10-14T154745.025Z.json`, beside run A's
`inventory-2026-10-14T130713.045Z.json`. Neither file is committed.

- In order: Email Obfuscation off, Web Analytics (`rum`) off, NEL off; the apex, then `www`, attached to
  `unleashed-landing`, each replacing its proxied AAAA `100::` placeholder; both new Advanced
  Certificates active about 2 m 40 s after the second attach; the redirect rule off, not deleted. The
  302 held after each attach, as Inference 1 predicted: the rule runs before the Worker on a custom
  domain.
- The coordinator's first probe a minute later got one stale 302 on the apex, and every later request
  got the landing. A rule change can take a short while to reach every edge machine. Forty requests
  per host a few minutes later, half with a cache-busting query, all answered 200.

## The live gate

From this host, with no token:

- **No 302 remains**: 40 of 40 requests per host answered 200, half with a cache-busting query.
- **The served bytes are the reference build's**: `/` on both hosts hashes like the 4c33c63 export's
  `dist/index.html`, the other nine files are byte-identical on both hosts and on `workers.dev`, and
  `/build.json` is `0.1.0+4c33c630`, production.
- **Headers**: the landing's CSP and the other page headers, no `nel` or `report-to`, and `http://`
  answers 301 to `https://` on both hosts. The app hosts answer as run A recorded: testnet 200 with its
  CSP, mainnet 302 to the Access login. NEL is off for them too, as the owner accepted.
- **Smoke from the export**: every Chromium case passed on both hosts, the live-only byte and
  `/cdn-cgi/` cases included. WebKit passed every case but the canvas-timing ones, which failed on
  different cases each run: 2 of 21 per host one page at a time, and 1 of 21 on the `workers.dev`
  control. The load average was 90 to 240 on 192 cores. This is phase 6's starvation pattern, not the
  host, since the bytes are identical; the owner's iPhone look is the Safari check.

## After the rule's deletion

The owner's iPhone look: "looks good". The owner then deleted the redirect rule and the
`unleashed-cutover` token. The Chromium live smoke from the 4c33c63 export exited 0 on both hosts
afterwards. Ten cache-busting requests per host all answered 200, with no `nel` or `report-to`, and
`http://` answers 301 to `https://`.

## Codex review of PR 2 (`gpt-6.1-sol`, high; session 01a13b54-9869-7d40-ba81-743cbc7d069b)

One pass over the close-out's diff, for drift from the live state and an adversarial read of the
cutover scripts. Four findings; all adopted.

- **Medium: a failing journal write stopped the rollback.** The error path journalled before it
  rolled back, and a throw there skipped the undo. Journal writes on the error path are now caught;
  a test pins it.
- **Medium: a timed-out change could pass as never applied.** A failed undo of a change whose call
  had thrown was logged as "skipped". Every failed undo is now `NOT REVERTED` (exit 4).
- **Low: comments named the plan's steps.** These are rewritten as what the code does and why.
- **Low: the design README overstated what a `core/` change reaches.** The app shell still inlines
  the mark; the sentence now says so.
