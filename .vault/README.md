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

## Migrating from keyring / totp

Browser storage is per origin, so data saved on `keyring.inpriv.xyz` / `totp.inpriv.xyz` is not visible
here. The old pages keep working while they hold data, show a banner, and forward visitors that have
nothing stored. Keyring: Export → Encrypted backup, then Import in Vault. TOTP: "Download backup"
on the old page, then "Import backup" in the Vault Authenticator tab.
