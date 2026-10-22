# Security tests

Local only: every Worker runs under `wrangler dev` with test-only secrets and
local D1 databases. Nothing here talks to production (the maintenance gate
still reads `admin.inpriv.xyz/public/state`, read-only, and the Mail page loads
`id.js` from id.inpriv.xyz, which does nothing on localhost).

```bash
tests/local.sh up                      # start landing, temp, admin, id, mail (+ HTML test Worker)
node --test tests/api.test.mjs         # 55 API checks
(cd tests && npm install)              # puppeteer-core, once
node --test --test-concurrency=1 tests/browser.test.mjs   # 11 checks in headless Firefox
node tests/probe.mjs                   # before/after probes (run on main too)
node tests/check-inline.mjs            # inlined renderer + served page copies match
tests/local.sh down                    # stop, delete local state and .dev.vars
```

- `FIREFOX=/path/to/firefox` picks the browser; `SHOTS=dir` saves phone-sized
  screenshots of the new screens.
- Each Worker runs in its own workerd process on the same SQLite files, so a
  write can hit `SQLITE_BUSY` locally (production D1 has a single writer). The
  test client retries reads and account setup only, and prints each retry.
- The browser tests read request bodies from inside the page (Firefox's
  driver doesn't expose them) and URLs and headers from the network.
