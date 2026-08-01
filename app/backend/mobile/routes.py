import json
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..config import APP_DIR
from ..db import get_db
from .auth import (
    DeviceIdentity,
    ack_credential,
    authenticate_token,
    claim_credential,
    confirm_pairing,
    list_devices,
    pairing_status,
    request_pairing,
    require_admin,
    require_device,
    revoke_device,
    start_admin_session,
    start_pairing,
)
from .catalog import asset_for_id, build_manifest, build_package, canonical_book, canonical_books
from .foreground import foreground_registry
from .progress import overwrite_desktop, preview


mobile_router = APIRouter(prefix="/api/mobile")
desktop_router = APIRouter(prefix="/api/desktop/mobile")


class PairRequest(BaseModel):
    short_code: str = Field(min_length=10, max_length=24)
    device_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")
    device_name: str = Field(min_length=1, max_length=80)


class PairSecret(BaseModel):
    poll_secret: str = Field(min_length=32, max_length=128)


class Anchor(BaseModel):
    book_content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    parser_version: str
    chapter_index: int = Field(ge=0)
    paragraph_index: int = Field(ge=0)
    character_offset: int = Field(ge=0)
    anchor_text_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    anchor_asset_id: str | None = Field(default=None, max_length=100)
    anchor_version: int = Field(ge=1)
    client_updated_at: str | None = Field(default=None, max_length=64)


class OverwriteRequest(BaseModel):
    direction: Literal["desktop_to_mobile", "mobile_to_desktop"]
    operation_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")
    target_revision: int = Field(ge=0)
    connection_epoch: str = Field(min_length=16, max_length=80)
    anchor: Anchor | None = None


@mobile_router.get("/health")
def mobile_health() -> dict:
    return {"status": "ok", "service": "listen-book-mobile"}


@desktop_router.post("/session")
def desktop_session(request: Request, response: Response) -> dict:
    return start_admin_session(request, response)


@desktop_router.post("/pair/start")
def desktop_pair_start(request: Request) -> dict:
    require_admin(request)
    return start_pairing()


@desktop_router.get("/pair/{session_id}")
def desktop_pair_status(session_id: str, request: Request) -> dict:
    require_admin(request)
    return pairing_status(session_id)


@desktop_router.post("/pair/{session_id}/confirm")
def desktop_pair_confirm(session_id: str, request: Request) -> dict:
    require_admin(request)
    return confirm_pairing(session_id)


@desktop_router.delete("/device/{device_id}")
def desktop_device_revoke(device_id: str, request: Request) -> dict:
    require_admin(request)
    return revoke_device(device_id)


@desktop_router.get("/devices")
def desktop_devices(request: Request) -> dict:
    require_admin(request)
    return {"devices": list_devices()}


@mobile_router.post("/pair/request")
def mobile_pair_request(payload: PairRequest) -> dict:
    return request_pairing(payload.short_code, payload.device_id, payload.device_name)


@mobile_router.post("/pair/{session_id}/claim")
def mobile_pair_claim(session_id: str, payload: PairSecret) -> dict:
    return claim_credential(session_id, payload.poll_secret)


@mobile_router.post("/pair/{session_id}/ack")
def mobile_pair_ack(session_id: str, payload: PairSecret) -> dict:
    return ack_credential(session_id, payload.poll_secret)


@mobile_router.get("/device")
def mobile_device(identity: DeviceIdentity = Depends(require_device)) -> dict:
    return {"device_id": identity.device_id, "device_name": identity.device_name, "paired": True}


@mobile_router.get("/sync/manifest")
def mobile_catalog(identity: DeviceIdentity = Depends(require_device)) -> dict:
    del identity
    with get_db() as db:
        books = canonical_books(db)
    return {"books": books}


@mobile_router.get("/books/{content_hash}/metadata")
def mobile_book_metadata(
    content_hash: str, identity: DeviceIdentity = Depends(require_device)
) -> dict:
    del identity
    with get_db() as db:
        book = canonical_book(db, content_hash)
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        return build_manifest(db, book)


@mobile_router.get("/books/{content_hash}/package")
def mobile_book_package(
    content_hash: str, identity: DeviceIdentity = Depends(require_device)
) -> Response:
    del identity
    with get_db() as db:
        book = canonical_book(db, content_hash)
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        _, payload, _ = build_package(db, book)
    import hashlib

    digest = hashlib.sha256(payload).hexdigest()
    return Response(
        payload,
        media_type="application/json",
        headers={"ETag": f'"{digest}"', "X-Content-SHA256": digest, "Cache-Control": "no-store"},
    )


@mobile_router.get("/books/{content_hash}/assets/{resource_id}")
def mobile_book_asset(
    content_hash: str,
    resource_id: str,
    identity: DeviceIdentity = Depends(require_device),
) -> FileResponse:
    del identity
    with get_db() as db:
        book = canonical_book(db, content_hash)
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        asset = asset_for_id(book["id"], resource_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(
        asset["path"],
        media_type=asset["media_type"],
        headers={
            "ETag": f'"{asset["sha256"]}"',
            "X-Content-SHA256": asset["sha256"],
            "Cache-Control": "no-store",
        },
    )


@mobile_router.get("/books/{content_hash}/progress/preview")
def mobile_progress_preview(
    content_hash: str, identity: DeviceIdentity = Depends(require_device)
) -> dict:
    del identity
    with get_db() as db:
        return preview(db, content_hash)


@mobile_router.post("/books/{content_hash}/progress/overwrite")
def mobile_progress_overwrite(
    content_hash: str,
    payload: OverwriteRequest,
    identity: DeviceIdentity = Depends(require_device),
) -> dict:
    foreground_registry.require(identity.device_id, payload.connection_epoch)
    if payload.direction == "desktop_to_mobile":
        with get_db() as db:
            result = preview(db, content_hash)
        if not result["desktop"]["anchor"]:
            return {"status": "source_progress_missing"}
        return {
            "status": "ready",
            "source_anchor": result["desktop"]["anchor"],
            "source_revision": result["desktop"]["revision"],
            "operation_id": payload.operation_id,
        }
    if payload.anchor is None:
        raise HTTPException(status_code=422, detail="Mobile source anchor is required")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        return overwrite_desktop(
            db,
            device_id=identity.device_id,
            content_hash=content_hash,
            anchor=payload.anchor.model_dump(),
            target_revision=payload.target_revision,
            operation_id=payload.operation_id,
        )


@mobile_router.websocket("/control")
async def mobile_control(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin and origin.split("://", 1)[-1].rstrip("/") != websocket.headers.get("host", ""):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    identity = None
    epoch = None
    try:
        message = await websocket.receive_json()
        if message.get("type") != "authenticate":
            await websocket.close(code=1008)
            return
        identity = authenticate_token(str(message.get("credential") or ""))
        if not identity or identity.device_id != message.get("device_id"):
            await websocket.close(code=1008)
            return
        epoch = foreground_registry.connect(identity.device_id)
        await websocket.send_json({"type": "authenticated", "connection_epoch": epoch})
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "suspended":
                break
            if message.get("type") == "heartbeat":
                if not foreground_registry.heartbeat(identity.device_id, epoch):
                    break
                await websocket.send_json({"type": "heartbeat_ack"})
    except Exception:
        pass
    finally:
        if identity and epoch:
            foreground_registry.disconnect(identity.device_id, epoch)
        try:
            await websocket.close()
        except Exception:
            pass


def install_mobile(app: FastAPI) -> None:
    mobile_dir = APP_DIR / "mobile"
    admin_dir = APP_DIR / "mobile_admin"

    @app.middleware("http")
    async def mobile_boundary(request: Request, call_next):
        path = request.url.path
        forwarded = any(
            header in request.headers
            for header in ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto")
        )
        if forwarded and not (path.startswith("/mobile/") or path.startswith("/api/mobile/")):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        response = await call_next(request)
        if path.startswith("/mobile/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' blob: data:; connect-src 'self' wss: ws:; object-src 'none'; "
                "base-uri 'none'; frame-ancestors 'none'"
            )
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
            if path == "/mobile/sw.js":
                response.headers["Cache-Control"] = "no-store, max-age=0"
            elif path.endswith(("/", ".html", ".js", ".css", ".webmanifest")):
                response.headers["Cache-Control"] = "no-cache, max-age=0, must-revalidate"
        if path.startswith("/api/mobile/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(desktop_router)
    app.include_router(mobile_router)
    if admin_dir.exists():
        app.mount("/mobile-admin", StaticFiles(directory=admin_dir, html=True), name="mobile-admin")
    if mobile_dir.exists():
        app.mount("/mobile", StaticFiles(directory=mobile_dir, html=True), name="mobile")
