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
