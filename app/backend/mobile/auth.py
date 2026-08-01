import base64
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request, Response

from ..config import DATA_DIR, DB_PATH
from ..db import get_db, utc_now


COOKIE_NAME = "listen_book_mobile_admin"
PAIRING_TTL_SECONDS = 300
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
SECRET_PATH = DATA_DIR / "mobile_server_secret"
_ADMIN_SESSIONS: dict[str, tuple[str, float]] = {}
_ADMIN_LOCK = threading.Lock()


@dataclass(frozen=True)
class DeviceIdentity:
    device_id: str
    device_name: str


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _server_secret() -> bytes:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        secret = SECRET_PATH.read_bytes()
    except FileNotFoundError:
        secret = secrets.token_bytes(32)
        try:
            with SECRET_PATH.open("xb") as target:
                target.write(secret)
        except FileExistsError:
            secret = SECRET_PATH.read_bytes()
    if len(secret) < 32:
        raise RuntimeError("Mobile server secret is invalid")
    return secret


def _digest(namespace: str, value: str) -> str:
    return hmac.new(
        _server_secret(), f"{namespace}:{value}".encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _credential(session_salt: str, device_id: str) -> str:
    raw = hmac.new(
        _server_secret(), f"credential:{session_salt}:{device_id}".encode(), hashlib.sha256
    ).digest()
    return _b64(raw)


def _security_log(
    db: sqlite3.Connection,
    event_type: str,
    result_code: str,
    device_id: str | None = None,
    operation_id: str | None = None,
) -> None:
    hint = hashlib.sha256(device_id.encode()).hexdigest()[:12] if device_id else None
    db.execute(
        """
        INSERT INTO mobile_security_log
        (event_type, result_code, device_hint, operation_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (event_type, result_code, hint, operation_id, utc_now()),
    )
    db.execute(
        """
        DELETE FROM mobile_security_log
        WHERE id NOT IN (
          SELECT id FROM mobile_security_log
          WHERE created_at >= datetime('now', '-30 days')
          ORDER BY id DESC LIMIT 2000
        )
        """
    )


def _is_direct_loopback(request: Request) -> bool:
    forwarded = any(
        header in request.headers
        for header in ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto")
    )
    host = (request.url.hostname or "").lower()
    origin = request.headers.get("origin")
    origin_ok = not origin or origin.rstrip("/") == str(request.base_url).rstrip("/")
    return not forwarded and host in {"127.0.0.1", "localhost", "::1"} and origin_ok


def start_admin_session(request: Request, response: Response) -> dict:
    if not _is_direct_loopback(request):
        raise HTTPException(status_code=403, detail="Desktop management requires direct loopback access")
    session_id = _b64(secrets.token_bytes(24))
    csrf = _b64(secrets.token_bytes(24))
    with _ADMIN_LOCK:
        now = time.time()
        expired = [key for key, (_, deadline) in _ADMIN_SESSIONS.items() if deadline <= now]
        for key in expired:
            _ADMIN_SESSIONS.pop(key, None)
        _ADMIN_SESSIONS[session_id] = (csrf, now + 3600)
    response.set_cookie(
        COOKIE_NAME,
        session_id,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        max_age=3600,
        path="/api/desktop/mobile",
    )
    return {"csrf_token": csrf, "expires_in": 3600}


def require_admin(request: Request) -> None:
    if not _is_direct_loopback(request):
        raise HTTPException(status_code=403, detail="Desktop management requires direct loopback access")
    session_id = request.cookies.get(COOKIE_NAME, "")
    csrf = request.headers.get("x-csrf-token", "")
    with _ADMIN_LOCK:
        stored = _ADMIN_SESSIONS.get(session_id)
    if not stored or stored[1] <= time.time() or not hmac.compare_digest(stored[0], csrf):
        raise HTTPException(status_code=403, detail="Invalid desktop session")


def start_pairing() -> dict:
    code = "".join(secrets.choice(CROCKFORD) for _ in range(10))
    session_id = str(uuid.uuid4())
    now = time.time()
    with get_db() as db:
        db.execute("DELETE FROM mobile_pairing_sessions WHERE expires_at < ?", (now - 86400,))
        db.execute(
            """
            INSERT INTO mobile_pairing_sessions
            (id, code_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, _digest("pair-code", code), now + PAIRING_TTL_SECONDS, utc_now()),
        )
        _security_log(db, "pair_start", "created")
    return {"session_id": session_id, "short_code": code, "expires_in": PAIRING_TTL_SECONDS}


def request_pairing(code: str, device_id: str, device_name: str) -> dict:
    normalized = "".join(character for character in code.upper() if character in CROCKFORD)
    if len(normalized) != 10:
        raise HTTPException(status_code=400, detail="Invalid pairing code")
    poll_secret = _b64(secrets.token_bytes(32))
    now = time.time()
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM mobile_pairing_sessions WHERE code_hash = ?",
            (_digest("pair-code", normalized),),
        ).fetchone()
        if (
            not row
            or row["expires_at"] <= now
            or row["consumed_at"]
            or row["rejected_at"]
            or row["acked_at"]
        ):
            _security_log(db, "pair_request", "invalid", device_id)
            raise HTTPException(status_code=400, detail="Pairing code is invalid or expired")
        db.execute(
            """
            UPDATE mobile_pairing_sessions
            SET consumed_at = ?, device_id = ?, device_name = ?, poll_secret_hash = ?, credential_salt = ?
            WHERE id = ?
            """,
            (
                utc_now(),
                device_id,
                device_name[:80],
                _digest("poll", poll_secret),
                _b64(secrets.token_bytes(32)),
                row["id"],
            ),
        )
        _security_log(db, "pair_request", "pending", device_id)
    return {"session_id": row["id"], "poll_secret": poll_secret, "status": "pending"}


def pairing_status(session_id: str) -> dict:
    with get_db() as db:
        row = db.execute(
            """
            SELECT id, expires_at, device_id, device_name, confirmed_at, acked_at, rejected_at
            FROM mobile_pairing_sessions WHERE id = ?
            """,
            (session_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Pairing session not found")
    status = "pending"
    if row["acked_at"]:
        status = "completed"
    elif row["confirmed_at"]:
        status = "confirmed"
    elif row["rejected_at"]:
        status = "rejected"
    elif row["expires_at"] <= time.time():
        status = "expired"
    return {
        "session_id": row["id"],
        "device_id": row["device_id"],
        "device_name": row["device_name"],
        "status": status,
    }


def confirm_pairing(session_id: str) -> dict:
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM mobile_pairing_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not row or not row["device_id"] or row["expires_at"] <= time.time():
            raise HTTPException(status_code=409, detail="Pairing request is not active")
        active = db.execute(
            "SELECT device_id FROM mobile_devices WHERE revoked_at IS NULL"
        ).fetchone()
        if active and active["device_id"] != row["device_id"]:
            raise HTTPException(status_code=409, detail="A mobile device is already paired")
        token = _credential(row["credential_salt"], row["device_id"])
        now = utc_now()
        db.execute(
            """
            INSERT INTO mobile_devices
            (device_id, device_name, credential_hash, created_at, last_seen_at, revoked_at)
            VALUES (?, ?, ?, ?, NULL, NULL)
            ON CONFLICT(device_id) DO UPDATE SET
              device_name = excluded.device_name,
              credential_hash = excluded.credential_hash,
              revoked_at = NULL
            """,
            (row["device_id"], row["device_name"], _digest("credential", token), now),
        )
        db.execute(
            "UPDATE mobile_pairing_sessions SET confirmed_at = ? WHERE id = ?",
            (now, session_id),
        )
        _security_log(db, "pair_confirm", "confirmed", row["device_id"])
    return {"session_id": session_id, "status": "confirmed"}


def claim_credential(session_id: str, poll_secret: str) -> dict:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM mobile_pairing_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        valid = (
            row
            and row["confirmed_at"]
            and not row["acked_at"]
            and not row["rejected_at"]
            and row["expires_at"] + 300 > time.time()
            and row["poll_secret_hash"]
            and hmac.compare_digest(row["poll_secret_hash"], _digest("poll", poll_secret))
        )
        if not valid:
            raise HTTPException(status_code=403, detail="Credential is not available")
        token = _credential(row["credential_salt"], row["device_id"])
    return {
        "status": "confirmed",
        "device_id": row["device_id"],
        "credential": token,
    }


def ack_credential(session_id: str, poll_secret: str) -> dict:
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM mobile_pairing_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if (
            not row
            or row["acked_at"]
            or not row["poll_secret_hash"]
            or not hmac.compare_digest(row["poll_secret_hash"], _digest("poll", poll_secret))
        ):
            raise HTTPException(status_code=403, detail="Credential acknowledgement rejected")
        now = utc_now()
        db.execute(
            """
            UPDATE mobile_pairing_sessions
            SET acked_at = ?, poll_secret_hash = NULL, credential_salt = NULL
            WHERE id = ?
            """,
            (now, session_id),
        )
        _security_log(db, "pair_ack", "completed", row["device_id"])
    return {"status": "completed"}


def authenticate_token(token: str, db_path: Path | None = None) -> DeviceIdentity | None:
    if not token:
        return None
    db_path = db_path or DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT device_id, device_name, credential_hash FROM mobile_devices WHERE revoked_at IS NULL"
        ).fetchall()
        digest = _digest("credential", token)
        for row in rows:
            if hmac.compare_digest(row["credential_hash"], digest):
                conn.execute(
                    "UPDATE mobile_devices SET last_seen_at = ? WHERE device_id = ?",
                    (utc_now(), row["device_id"]),
                )
                conn.commit()
                return DeviceIdentity(row["device_id"], row["device_name"])
    finally:
        conn.close()
    return None


def require_device(request: Request) -> DeviceIdentity:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    identity = authenticate_token(token) if scheme.lower() == "bearer" else None
    if not identity:
        raise HTTPException(status_code=401, detail="Device credential is invalid or revoked")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(status_code=403, detail="Origin is not allowed")
    return identity


def revoke_device(device_id: str) -> dict:
    with get_db() as db:
        row = db.execute(
            "SELECT device_id FROM mobile_devices WHERE device_id = ? AND revoked_at IS NULL",
            (device_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Active device not found")
        db.execute(
            "UPDATE mobile_devices SET revoked_at = ? WHERE device_id = ?", (utc_now(), device_id)
        )
        _security_log(db, "device_revoke", "revoked", device_id)
    return {"revoked": True, "device_id": device_id}


def list_devices() -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            """
            SELECT device_id, device_name, created_at, last_seen_at, revoked_at
            FROM mobile_devices ORDER BY created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]
