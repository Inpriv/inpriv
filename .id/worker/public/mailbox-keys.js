// Inpriv ID — mailbox key ceremony used once, right after sign-up.
//
// This is the same ceremony the Mail page runs when it creates a mailbox
// (.mail/index.html: generateKeyPair / newRingKey / sealRing / derivePassphraseKey,
// PBKDF2-SHA-256 600k, AAD "inpriv-mail-keyring-v2"). The private key is
// generated here, sealed here and never leaves the browser: what travels is the
// public key (SPKI) and the sealed envelope, exactly as Mail's own endpoint
// expects.
//
// Keep the two copies identical. If the ring format changes, change both.
/* global window, crypto, TextEncoder, TextDecoder */
(function () {
  var KEY_ITERS = 600000;
  var RING_AAD = new TextEncoder().encode('inpriv-mail-keyring-v2');
  var RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };

  function b64enc(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64dec(str) {
    var raw = atob(str), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  var utf8 = {
    enc: function (s) { return new TextEncoder().encode(String(s)); },
    dec: function (b) { return new TextDecoder().decode(b); }
  };

  function generateKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // First 128 bits of SHA-256 over the public key (SPKI), in hex. The server
  // computes the same value; people compare it to check a key.
  async function keyIdOf(spki) {
    var d = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
    return Array.from(d.slice(0, 16), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  async function derivePassphraseKey(passphrase, saltB64, iterations) {
    var base = await crypto.subtle.importKey('raw', utf8.enc(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64dec(saltB64), iterations: iterations },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function openRing(envelope, kek) {
    var pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64dec(envelope.priv_iv), additionalData: RING_AAD },
      kek, b64dec(envelope.encrypted_private_key));
    return JSON.parse(utf8.dec(pt));
  }

  // Seal, then open the result again with a freshly derived key: nothing is
  // sent unless it is known to open.
  async function sealRing(ring, passphrase) {
    var salt = b64enc(crypto.getRandomValues(new Uint8Array(16)).buffer);
    var kek = await derivePassphraseKey(passphrase, salt, KEY_ITERS);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: RING_AAD }, kek, utf8.enc(JSON.stringify(ring)));
    var envelope = {
      key_format: 2,
      encrypted_private_key: b64enc(ct),
      priv_iv: b64enc(iv.buffer),
      priv_salt: salt,
      priv_iter: KEY_ITERS
    };
    var again = await openRing(envelope, await derivePassphraseKey(passphrase, salt, KEY_ITERS));
    if (JSON.stringify(again) !== JSON.stringify(ring)) throw new Error('key ring check failed');
    return { envelope: envelope, kek: kek };
  }

  async function newRingKey() {
    var kp = await generateKeyPair();
    var spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    var pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    return { entry: { id: await keyIdOf(spki), created: Date.now(), pkcs8: b64enc(pkcs8) }, spki: b64enc(spki) };
  }

  // Create the mailbox on Inpriv Mail with the ticket Inpriv ID just minted.
  // Mail answers opaquely (it has no CORS on purpose); the caller confirms
  // through /api/mailbox/status.
  async function provision(opts) {
    var username = String(opts.username || '').toLowerCase();
    var passphrase = String(opts.passphrase || '');
    if (!username || passphrase.length < 8) throw new Error('passphrase too short');
    var k = await newRingKey();
    var ring = { v: 2, current: k.entry.id, keys: [k.entry] };
    var sealed = await sealRing(ring, passphrase);
    await fetch(opts.mailOrigin + '/api/v1/init-keys', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        init_ticket: opts.ticket,
        public_key: k.spki,
        key_id: k.entry.id,
        envelope: sealed.envelope
      })
    });
  }

  window.InprivMailboxKeys = { provision: provision, keyIdOf: keyIdOf };
})();
