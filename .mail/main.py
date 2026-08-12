"""
================================================================================
 INPRIV — Zero-Knowledge Encrypted Mail Backend
 FastAPI + SQLModel + SQLite + Argon2 + JWT
================================================================================

 ⚠️  DEPLOYMENT — CLOUDFLARE EMAIL WORKER (Catch-All → /api/v1/inbound-email)
================================================================================

Paste the following into a Cloudflare Email Worker bound to Email Routing.
Set the route as a "Catch-All" action → "Send to Worker" so EVERY message to
*@inpriv.xyz is captured. No per-user routing rules are required.

--------------------------------------------------------------------------------
// worker.js  —  Cloudflare Email Worker (Catch-All for *@inpriv.xyz)
--------------------------------------------------------------------------------
export default {
  async email(message, env, ctx) {
    // Allowed recipients (anti-spoof) — set to your domain.
    const ALLOWED = ["inpriv.xyz"];

    const to = (message.to || "").toLowerCase();
    const domain = to.split("@")[1] || "";
    if (!ALLOWED.includes(domain)) {
      message.setReject(`Domain not allowed: ${domain}`);
      return;
    }

    // Read the raw RFC822 stream
    const raw = await new Response(message.raw).text();

    // Parse essential headers
    const from = message.from || "";
    const subject = message.headers.get("subject") || "(no subject)";
    const date    = message.headers.get("date")    || new Date().toUTCString();
    const messageId = message.headers.get("message-id") || crypto.randomUUID();

    // Forward to backend
    const payload = {
      from,
      to,
      subject,
      date,
      message_id: messageId,
      raw,
      headers: Object.fromEntries(message.headers.entries())
    };

    const resp = await fetch("https://mail.inpriv.xyz/api/v1/inbound-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": env.INBOUND_EMAIL_SECRET
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      message.setReject(`Backend rejected: ${resp.status}`);
    }
  }
};
--------------------------------------------------------------------------------

 ⚠️  DNS — Cloudflare Setup for inpriv.xyz
================================================================================

1. CLOUDFLARE TUNNEL (cloudflared) — exposes FastAPI on mail.inpriv.xyz
   $ cloudflared tunnel create inpriv
   $ cloudflared tunnel route dns inpriv mail.inpriv.xyz
   # config.yml:
   tunnel: <TUNNEL_UUID>
   credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json
   ingress:
     - hostname: mail.inpriv.xyz
       service: http://127.0.0.1:8000
     - service: http_status:404

2. MX RECORD (Cloudflare Email Routing — automatic when enabled):
   Type: MX    Name: @                 Content: route1.mx.cloudflare.net   Priority: 13
   Type: MX    Name: @                 Content: route2.mx.cloudflare.net   Priority: 22
   Type: MX    Name: @                 Content: route3.mx.cloudflare.net   Priority: 49
   (Cloudflare auto-creates these when Email Routing is toggled ON.)

3. CATCH-ALL ROUTE:
   Email → Routing → Catch-all address → Action: "Send to a Worker" → worker.js
   (No per-user rule needed. Any username@inpriv.xyz becomes a valid mailbox
    the moment the user registers; the Worker forwards it to this backend.)

4. ENV VARS (FastAPI host):
   - JWT_SECRET             : 64+ char random string
   - INBOUND_EMAIL_SECRET   : shared secret also set in Worker env (must match)
   - CORS_ORIGINS           : https://mail.inpriv.xyz
   - DB_PATH                : /var/lib/inpriv/inpriv.db (default: ./inpriv.db)

5. RUN:
   $ pip install fastapi uvicorn[standard] sqlmodel python-jose[cryptography]
                  argon2-cffi pydantic-settings
   $ uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers

================================================================================
"""

from __future__ import annotations

import os
import secrets
import base64
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

# ----------------------------- Dependencies ----------------------------------
from fastapi import (
    FastAPI, HTTPException, Depends, Request, Header, status, Query
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from pydantic_settings import BaseSettings
from sqlmodel import SQLModel, Field as SQLField, Session, create_engine, select
from jose import jwt, JWTError
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# ----------------------------- Settings --------------------------------------
class Settings(BaseSettings):
    jwt_secret: str = "CHANGE_ME-dev-only-do-not-use-in-prod-" + secrets.token_hex(16)
    inbound_email_secret: str = "CHANGE_ME_INBOUND_SECRET"
    jwt_algorithm: str = "HS256"
    jwt_ttl_days: int = 30
    db_path: str = "inpriv.db"
    cors_origins: str = "*"
    username_re: str = r"^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$"

    class Config:
        env_prefix = ""
        env_file = ".env"

settings = Settings()
USERNAME_PATTERN = re.compile(settings.username_re)
ph = PasswordHasher()

# ----------------------------- Database --------------------------------------
DATABASE_URL = f"sqlite:///{settings.db_path}"
engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False, "timeout": 30},
)

class User(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    username: str = SQLField(unique=True, index=True)
    email: str = SQLField(unique=True, index=True)
    # Argon2 hash of the user's password (server auth only).
    password_hash: str
    # Public RSA-OAEP-2048 key (SPKI, base64 DER).
    public_key: str
    # AES-GCM-encrypted PKCS#8 private key (base64).
    encrypted_private_key: str
    priv_iv: str           # base64 IV for the wrapped private key
    priv_salt: str         # base64 PBKDF2 salt
    priv_iter: int         # PBKDF2 iteration count
    created_at: datetime = SQLField(default_factory=lambda: datetime.now(timezone.utc))

class Message(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    owner_id: int = SQLField(index=True, foreign_key="user.id")
    direction: str = SQLField(index=True)          # "inbound" | "outbound"
    peer_address: str = SQLField(index=True)       # from (inbound) or to (outbound)
    peer_label: str = ""                            # display name if available
    subject: str = ""
    # Hybrid-encrypted body. For internal mail all three are populated.
    # For inbound external mail, encrypted_aes_key holds the RSA-wrapped key
    # and ciphertext holds the AES-GCM sealed body.
    encrypted_aes_key: str = ""
    iv: str = ""
    ciphertext: str = ""
    auth_tag: str = ""
    # Optional raw envelope for inbound messages (kept for audit / headers).
    raw_headers: str = ""
    is_read: bool = False
    created_at: datetime = SQLField(default_factory=lambda: datetime.now(timezone.utc))

def get_session():
    with Session(engine) as s:
        yield s

def init_db():
    SQLModel.metadata.create_all(engine)

# ----------------------------- Auth ------------------------------------------
def _b64(d: bytes) -> str:
    return base64.b64encode(d).decode("ascii")

def _ub64(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))

def create_access_token(user_id: int, username: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=settings.jwt_ttl_days)).timestamp()),
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

async def current_user(
    request: Request,
    session: Session = Depends(get_session),
) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = auth.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        uid = int(payload["sub"])
    except (JWTError, ValueError, KeyError):
        raise HTTPException(401, "Invalid or expired token")
    user = session.get(User, uid)
    if not user:
        raise HTTPException(401, "User not found")
    return user

# ----------------------------- Crypto helpers (server-side) ------------------
# Used ONLY for inbound external mail — wraps an AES key with the recipient's
# public RSA key. Server never has the private key, so it cannot decrypt.
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def hybrid_encrypt_for(public_key_b64: str, plaintext: bytes) -> dict:
    """Returns {encrypted_aes_key, iv, ciphertext, auth_tag} all base64."""
    der = _ub64(public_key_b64)
    pub = serialization.load_der_public_key(der)
    if not isinstance(pub, rsa.RSAPublicKey):
        raise ValueError("Public key is not RSA")
    aes_key = secrets.token_bytes(32)
    iv = secrets.token_bytes(12)
    aesgcm = AESGCM(aes_key)
    ct = aesgcm.encrypt(iv, plaintext, None)  # ct includes 16-byte tag at tail
    wrapped = pub.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return {
        "encrypted_aes_key": _b64(wrapped),
        "iv": _b64(iv),
        "ciphertext": _b64(ct[:-16]),
        "auth_tag": _b64(ct[-16:]),
    }

# ----------------------------- Pydantic schemas ------------------------------
class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=10, max_length=256)
    password_confirm: str
    public_key: str
    encrypted_private_key: str
    priv_iv: str
    priv_salt: str
    priv_iter: int = Field(ge=100_000, le=10_000_000)

    @field_validator("username")
    @classmethod
    def _v_username(cls, v: str) -> str:
        v = v.strip().lower()
        if not USERNAME_PATTERN.match(v):
            raise ValueError("Username must be 2-32 chars: a-z0-9._- (no leading/trailing dot/dash)")
        return v

    @field_validator("password_confirm")
    @classmethod
    def _v_match(cls, v, info):
        if info.data.get("password") != v:
            raise ValueError("Passwords do not match")
        return v

class LoginRequest(BaseModel):
    username: str
    password: str

class SendRequest(BaseModel):
    to_username: str
    subject: str = Field(default="", max_length=240)
    encrypted_aes_key: str
    iv: str
    ciphertext: str
    auth_tag: str

class InboundEmailPayload(BaseModel):
    from_: str = Field(alias="from")
    to: str
    subject: str = ""
    date: str = ""
    message_id: str = ""
    raw: str = ""
    headers: dict = Field(default_factory=dict)

    model_config = {"populate_by_name": True}

# ----------------------------- App -------------------------------------------
app = FastAPI(
    title="Inpriv — Zero-Knowledge Mail",
    version="1.0.0",
    docs_url="/docs" if os.environ.get("INPRIV_DEV") else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")] if settings.cors_origins != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def _startup():
    init_db()

@app.get("/api/v1/health")
def health():
    return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat()}

# ----------------------------- Auth endpoints --------------------------------
@app.post("/api/v1/register")
def register(req: RegisterRequest, session: Session = Depends(get_session)):
    email = f"{req.username}@inpriv.xyz"
    exists = session.exec(select(User).where(
        (User.username == req.username) | (User.email == email)
    )).first()
    if exists:
        raise HTTPException(409, "Username already taken")
    user = User(
        username=req.username,
        email=email,
        password_hash=ph.hash(req.password),
        public_key=req.public_key,
        encrypted_private_key=req.encrypted_private_key,
        priv_iv=req.priv_iv,
        priv_salt=req.priv_salt,
        priv_iter=req.priv_iter,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(user.id, user.username)
    return {
        "token": token,
        "user": _public_user(user),
    }

@app.post("/api/v1/login")
def login(req: LoginRequest, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == req.username.strip().lower())).first()
    if not user:
        # Constant-ish failure path
        try:
            ph.verify("$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcA", "x")
        except Exception:
            pass
        raise HTTPException(401, "Invalid credentials")
    try:
        ph.verify(user.password_hash, req.password)
    except VerifyMismatchError:
        raise HTTPException(401, "Invalid credentials")
    if ph.check_needs_rehash(user.password_hash):
        user.password_hash = ph.hash(req.password)
        session.add(user)
        session.commit()
    token = create_access_token(user.id, user.username)
    return {
        "token": token,
        "user": _public_user(user),
    }

@app.get("/api/v1/me")
def me(user: User = Depends(current_user)):
    return _public_user(user)

@app.get("/api/v1/keys/private")
def get_private_key(user: User = Depends(current_user)):
    """Returns the encrypted private-key bundle. Browser derives AES key from
    password client-side and decrypts locally. Server cannot decrypt."""
    return {
        "encrypted_private_key": user.encrypted_private_key,
        "priv_iv": user.priv_iv,
        "priv_salt": user.priv_salt,
        "priv_iter": user.priv_iter,
        "public_key": user.public_key,
    }

@app.get("/api/v1/users/{username}/pubkey")
def get_pubkey(username: str, user: User = Depends(current_user)):
    target = session_exec_get_user_by_username(username)
    if not target:
        raise HTTPException(404, "Recipient not found")
    return {"username": target.username, "public_key": target.public_key}

def session_exec_get_user_by_username(username: str) -> Optional[User]:
    with Session(engine) as s:
        return s.exec(select(User).where(User.username == username.strip().lower())).first()

# ----------------------------- Messages --------------------------------------
@app.get("/api/v1/messages")
def list_messages(
    direction: Optional[str] = Query(None, pattern="^(inbound|outbound)$"),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    stmt = select(Message).where(Message.owner_id == user.id)
    if direction:
        stmt = stmt.where(Message.direction == direction)
    stmt = stmt.order_by(Message.created_at.desc()).limit(500)
    rows = session.exec(stmt).all()
    return {"items": [_msg_summary(m) for m in rows]}

@app.get("/api/v1/messages/{msg_id}")
def get_message(
    msg_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    m = session.get(Message, msg_id)
    if not m or m.owner_id != user.id:
        raise HTTPException(404, "Not found")
    if not m.is_read and m.direction == "inbound":
        m.is_read = True
        session.add(m)
        session.commit()
    return _msg_detail(m)

@app.delete("/api/v1/messages/{msg_id}")
def delete_message(
    msg_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    m = session.get(Message, msg_id)
    if not m or m.owner_id != user.id:
        raise HTTPException(404, "Not found")
    session.delete(m)
    session.commit()
    return {"ok": True}

@app.post("/api/v1/messages/send")
def send_message(
    req: SendRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    target = session.exec(
        select(User).where(User.username == req.to_username.strip().lower())
    ).first()
    if not target:
        raise HTTPException(404, "Recipient not found")
    outbox = Message(
        owner_id=user.id,
        direction="outbound",
        peer_address=f"{target.username}@inpriv.xyz",
        peer_label=target.username,
        subject=req.subject,
        encrypted_aes_key=req.encrypted_aes_key,
        iv=req.iv,
        ciphertext=req.ciphertext,
        auth_tag=req.auth_tag,
    )
    inbox = Message(
        owner_id=target.id,
        direction="inbound",
        peer_address=f"{user.username}@inpriv.xyz",
        peer_label=user.username,
        subject=req.subject,
        encrypted_aes_key=req.encrypted_aes_key,
        iv=req.iv,
        ciphertext=req.ciphertext,
        auth_tag=req.auth_tag,
    )
    session.add(outbox)
    session.add(inbox)
    session.commit()
    return {"ok": True, "id": outbox.id}

# ----------------------------- Inbound webhook -------------------------------
@app.post("/api/v1/inbound-email")
async def inbound_email(
    payload: InboundEmailPayload,
    request: Request,
    x_webhook_secret: str = Header(default="", alias="X-Webhook-Secret"),
    session: Session = Depends(get_session),
):
    # Constant-time secret compare
    if not secrets.compare_digest(x_webhook_secret, settings.inbound_email_secret):
        raise HTTPException(401, "Bad secret")

    # Extract recipient username from "to"
    to_addr = (payload.to or "").strip().lower()
    if "@" not in to_addr:
        return JSONResponse({"ok": False, "reason": "bad to"}, status_code=400)
    username, domain = to_addr.split("@", 1)
    if domain.lower() != "inpriv.xyz":
        return JSONResponse({"ok": False, "reason": "wrong domain"}, status_code=400)
    if not USERNAME_PATTERN.match(username):
        return JSONResponse({"ok": False, "reason": "bad username"}, status_code=400)

    user = session.exec(select(User).where(User.username == username)).first()
    if not user:
        # Silently accept to avoid leaking valid usernames; drop the message.
        return {"ok": True, "accepted": False, "reason": "no such user"}

    # Build display body — plaintext rendering of the raw RFC822
    body_text = _render_text_body(payload.raw, payload.headers)
    envelope = (
        f"From: {payload.from_}\n"
        f"To: {payload.to}\n"
        f"Subject: {payload.subject}\n"
        f"Date: {payload.date}\n"
        f"Message-ID: {payload.message_id}\n"
        f"----------------------------------------\n\n"
        f"{body_text}"
    ).encode("utf-8")

    enc = hybrid_encrypt_for(user.public_key, envelope)
    msg = Message(
        owner_id=user.id,
        direction="inbound",
        peer_address=payload.from_,
        peer_label=_extract_name(payload.from_),
        subject=payload.subject[:240] or "(no subject)",
        encrypted_aes_key=enc["encrypted_aes_key"],
        iv=enc["iv"],
        ciphertext=enc["ciphertext"],
        auth_tag=enc["auth_tag"],
        raw_headers=json.dumps(payload.headers)[:8000],
    )
    session.add(msg)
    session.commit()
    return {"ok": True, "accepted": True, "id": msg.id}

# ----------------------------- Helpers ---------------------------------------
def _public_user(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "public_key": u.public_key,
        "encrypted_private_key": u.encrypted_private_key,
        "priv_iv": u.priv_iv,
        "priv_salt": u.priv_salt,
        "priv_iter": u.priv_iter,
        "created_at": u.created_at.isoformat(),
    }

def _msg_summary(m: Message) -> dict:
    return {
        "id": m.id,
        "direction": m.direction,
        "peer_address": m.peer_address,
        "peer_label": m.peer_label or m.peer_address,
        "subject": m.subject,
        "is_read": m.is_read,
        "created_at": m.created_at.isoformat(),
    }

def _msg_detail(m: Message) -> dict:
    d = _msg_summary(m)
    d.update({
        "encrypted_aes_key": m.encrypted_aes_key,
        "iv": m.iv,
        "ciphertext": m.ciphertext,
        "auth_tag": m.auth_tag,
        "raw_headers": m.raw_headers,
    })
    return d

def _extract_name(addr: str) -> str:
    # "Jane Doe <jane@example.com>" -> "Jane Doe"
    if "<" in addr:
        return addr.split("<", 1)[0].strip().strip('"') or addr
    return addr

def _render_text_body(raw: str, headers: dict) -> str:
    """Best-effort plaintext body extraction from RFC822."""
    if not raw:
        return ""
    # Split headers/body
    parts = re.split(r"\r?\n\r?\n", raw, maxsplit=1)
    body = parts[1] if len(parts) == 2 else ""
    # Strip quoted-printable soft breaks
    body = body.replace("=\r\n", "").replace("=\n", "")
    # Strip HTML tags if it's an HTML-only message
    if "<html" in body.lower() or "<body" in body.lower():
        body = re.sub(r"<[^>]+>", " ", body)
        body = re.sub(r"\s+", " ", body).strip()
    return body[:50_000]

# ----------------------------- Main ------------------------------------------
if __name__ == "__main__":
    import uvicorn
    init_db()
    uvicorn.run(app, host="127.0.0.1", port=8000, proxy_headers=True)