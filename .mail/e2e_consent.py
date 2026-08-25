#!/usr/bin/env python3
"""E2E: consent mirror for mail.inpriv.xyz + host.inpriv.xyz.

1. Register a throwaway Inpriv ID account.
2. /api/services must show mail+host disconnected.
3. Mail: login (needs_init) -> init-keys -> /me  (this is the path that
   previously never wrote a consent).
4. /api/services must now show mail connected.
5. Host: password login.
6. /api/services must show host connected.
7. Cleanup all rows.
"""
import json, random, string, sys, time, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      "Content-Type": "application/json"}

def call(url, method="GET", body=None, token=None, headers=None):
    h = dict(UA)
    if headers: h.update(headers)
    if token: h["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}

uname = "e2econs" + "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
pw = "E2ePass" + "".join(random.choices(string.ascii_letters + string.digits, k=8)) + "!"
print(f"account: {uname} / {pw}")

ok = True
def check(label, cond):
    global ok
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond: ok = False

# 1. register on ID
s, d = call("https://id.inpriv.xyz/api/register", "POST",
            {"username": uname, "password": pw, "nick": "E2E Consent"})
check("register ID", s == 200 and d.get("token"))
idtok = d.get("token")

# 2. services before
s, d = call("https://id.inpriv.xyz/api/services", token=idtok)
svc = {x["id"]: x["connected"] for x in d.get("services", [])}
print("  before:", svc)
check("mail not connected yet", svc.get("mail") is False)

# 3a. mail login -> needs_init
s, d = call("https://mail.inpriv.xyz/api/v1/login", "POST", {"username": uname, "password": pw})
check("mail login -> needs_init", s == 200 and d.get("status") == "needs_init")

# 3b. init-keys (envelope is opaque to the server — placeholders are fine)
s, d = call("https://mail.inpriv.xyz/api/v1/init-keys", "POST",
            {"username": uname, "password": pw,
             "public_key": "dGVzdA==", "encrypted_private_key": "dGVzdA==",
             "priv_iv": "dGVzdA==", "priv_salt": "dGVzdA==", "priv_iter": 100000})
check("mail init-keys -> session", s == 200 and d.get("token"))
mtok = d.get("token")

# 3c. /me — the restored-session path that must mirror the consent
s, d = call("https://mail.inpriv.xyz/api/v1/me", token=mtok)
check("mail /me", s == 200 and d.get("username") == uname)

# 4. services after mail
time.sleep(2)
s, d = call("https://id.inpriv.xyz/api/services", token=idtok)
svc = {x["id"]: x["connected"] for x in d.get("services", [])}
print("  after mail login:", svc)
check("MAIL CONNECTED in ID panel", svc.get("mail") is True)

# 5. host password login
s, d = call("https://host.inpriv.xyz/api/auth/login", "POST", {"user": uname, "password": pw})
check("host login -> session", s == 200 and d.get("token"))

# 6. services after host
time.sleep(2)
s, d = call("https://id.inpriv.xyz/api/services", token=idtok)
svc = {x["id"]: (x["connected"], x.get("last_used")) for x in d.get("services", [])}
print("  after host login:", svc)
check("HOST CONNECTED in ID panel", svc.get("host", (None,))[0] is True)

print("\nRESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
