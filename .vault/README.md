# Inpriv Vault

[vault.inpriv.xyz](https://vault.inpriv.xyz) — passwords, authenticator codes and a generator in one place.

| Page | Was | What it does |
|---|---|---|
| `/` Passwords | keyring.inpriv.xyz | Encrypted local password vault (Inpriv ID Quick Unlock supported) |
| `/totp/` Authenticator | totp.inpriv.xyz | TOTP codes and 2FA secrets, optional passphrase |
| `/generator/` Generator | new | Random passwords (`crypto.getRandomValues`, rejection sampling) |

The pages are the original tools, served top-level on one origin with a small switcher under the
header (top-level so the Inpriv ID widget keeps working). Vault data stays in this browser's
`localStorage`; nothing is sent anywhere.

`keyring.inpriv.xyz` and `totp.inpriv.xyz` answer with a 301 to `/` and `/totp/`. Browser storage is per origin, so
vaults saved on the old hosts are not visible here (none existed when this was merged).
