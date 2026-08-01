import hashlib
import json
import re
import mimetypes
import sqlite3
from pathlib import Path
from urllib.parse import quote

from ..config import EPUB_ASSET_DIR
from .constants import ANCHOR_VERSION, PACKAGE_SCHEMA_VERSION, PARSER_VERSION


def mobile_display_title(value: str | None) -> str:
    raw = (value or "未命名书籍").strip()
    bracket = re.compile(r"（([^）]+)）|\(([^)]+)\)|【([^】]+)】|\[([^]]+)\]")
    groups = [next(part for part in match.groups() if part is not None).strip() for match in bracket.finditer(raw)]
    version = next(
        (group for group in groups if re.search(r"(?:版|修订|增订|珍藏|典藏)", group)),
        None,
    )
    main = bracket.split(raw, maxsplit=1)[0].strip()
    main = re.split(r"[:：]", main, maxsplit=1)[0].strip() or raw
    return f"{main}（{version}）" if version else main


def content_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ensure_book_hash(conn: sqlite3.Connection, book: sqlite3.Row) -> str | None:
    path = Path(book["file_path"])
    try:
        stat = path.stat()
    except OSError:
        return None
    current = book["content_hash"]
    unchanged = (
        current
        and int(book["file_size"] or -1) == stat.st_size
        and int(book["file_mtime"] or -1) == int(stat.st_mtime)
    )
    if unchanged:
        return str(current)
    digest = content_sha256(path)
    conn.execute(
        """
        UPDATE books
        SET content_hash = ?, parser_version = ?, file_size = ?, file_mtime = ?
        WHERE id = ?
        """,
        (digest, PARSER_VERSION, stat.st_size, int(stat.st_mtime), book["id"]),
    )
    return digest


def canonical_books(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM books ORDER BY created_at, id").fetchall()
    candidates: dict[str, list[tuple[bool, sqlite3.Row]]] = {}
    unavailable: list[dict] = []
    for row in rows:
        digest = ensure_book_hash(conn, row)
        if not digest:
            unavailable.append(
                {
                    "desktop_book_id": row["id"],
                    "title": row["title"] or "未命名书籍",
                    "format": row["file_format"],
                    "availability": "unavailable",
                    "reason": "source_file_unreadable",
                }
            )
            continue
        candidates.setdefault(digest, []).append((Path(row["file_path"]).is_file(), row))

    result: list[dict] = []
    for digest, entries in candidates.items():
        entries.sort(key=lambda item: (not item[0], item[1]["created_at"], item[1]["id"]))
        row = entries[0][1]
        result.append(
            {
                "desktop_book_id": row["id"],
                "content_hash": digest,
                "title": mobile_display_title(row["title"]),
                "author": row["author"],
                "format": row["file_format"],
                "file_size": row["file_size"],
                "parser_version": PARSER_VERSION,
                "anchor_version": ANCHOR_VERSION,
                "availability": "available",
                "duplicate_count": len(entries) - 1,
            }
        )
    result.sort(key=lambda item: item["title"].casefold())
    return result + unavailable


def canonical_book(conn: sqlite3.Connection, content_hash: str) -> sqlite3.Row | None:
    rows = conn.execute(
        "SELECT * FROM books WHERE content_hash = ? ORDER BY created_at, id", (content_hash,)
    ).fetchall()
    if not rows:
        canonical_books(conn)
        rows = conn.execute(
            "SELECT * FROM books WHERE content_hash = ? ORDER BY created_at, id", (content_hash,)
        ).fetchall()
    readable = [row for row in rows if Path(row["file_path"]).is_file()]
    return (readable or rows or [None])[0]


def _asset_map(book_id: str) -> dict[str, dict]:
    root = (EPUB_ASSET_DIR / book_id).resolve()
    if not root.is_dir():
        return {}
    assets: dict[str, dict] = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        resource_id = "asset-" + hashlib.sha256(relative.encode("utf-8")).hexdigest()[:24]
        payload = path.read_bytes()
        assets[resource_id] = {
            "resource_id": resource_id,
            "relative_path": relative,
            "path": path,
            "byte_size": len(payload),
            "sha256": sha256_bytes(payload),
            "media_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        }
    return assets


def build_package(conn: sqlite3.Connection, book: sqlite3.Row) -> tuple[dict, bytes, dict[str, dict]]:
    assets = _asset_map(book["id"])
    url_to_id = {
        f"/api/books/{book['id']}/assets/{quote(asset['relative_path'], safe='/')}": resource_id
        for resource_id, asset in assets.items()
    }
    chapter_rows = conn.execute(
        "SELECT chapter_index, title FROM chapters WHERE book_id = ? ORDER BY chapter_index",
        (book["id"],),
    ).fetchall()
    chapters: list[dict] = []
    for chapter in chapter_rows:
        paragraphs = []
        rows = conn.execute(
            """
            SELECT paragraph_index, text, html
            FROM paragraphs
            WHERE book_id = ? AND chapter_index = ?
            ORDER BY paragraph_index
            """,
            (book["id"], chapter["chapter_index"]),
        ).fetchall()
        for row in rows:
            html = row["html"]
            if html:
                for old_url, resource_id in url_to_id.items():
                    html = html.replace(old_url, f"asset://{resource_id}")
            paragraphs.append(
                {
                    "paragraph_index": row["paragraph_index"],
                    "text": row["text"],
                    "html": html,
                }
            )
        chapters.append(
            {
                "chapter_index": chapter["chapter_index"],
                "title": chapter["title"] or f"第 {chapter['chapter_index'] + 1} 章",
                "paragraphs": paragraphs,
            }
        )
    package = {
        "schema_version": PACKAGE_SCHEMA_VERSION,
        "parser_version": PARSER_VERSION,
        "anchor_version": ANCHOR_VERSION,
        "book_content_hash": book["content_hash"],
        "metadata": {
            "title": mobile_display_title(book["title"]),
            "author": book["author"],
            "format": book["file_format"],
            "epub_css": book["epub_css"] or "",
        },
        "chapters": chapters,
    }
    payload = json.dumps(
        package, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return package, payload, assets


def build_manifest(conn: sqlite3.Connection, book: sqlite3.Row) -> dict:
    _, package_bytes, assets = build_package(conn, book)
    resources = [
        {
            "resource_id": "package",
            "type": "chapter",
            "byte_size": len(package_bytes),
            "sha256": sha256_bytes(package_bytes),
            "etag": f'"{sha256_bytes(package_bytes)}"',
            "required": True,
            "url": f"/api/mobile/books/{book['content_hash']}/package",
        }
    ]
    for resource_id, asset in assets.items():
        resources.append(
            {
                "resource_id": resource_id,
                "type": "image",
                "byte_size": asset["byte_size"],
                "sha256": asset["sha256"],
                "etag": '"{}"'.format(asset["sha256"]),
                "required": True,
                "url": f"/api/mobile/books/{book['content_hash']}/assets/{resource_id}",
            }
        )
    revision_source = "".join(item["sha256"] for item in resources).encode("ascii")
    return {
        "schema_version": PACKAGE_SCHEMA_VERSION,
        "parser_version": PARSER_VERSION,
        "anchor_version": ANCHOR_VERSION,
        "package_revision": sha256_bytes(revision_source),
        "book_content_hash": book["content_hash"],
        "metadata": {
            "title": mobile_display_title(book["title"]),
            "author": book["author"],
            "format": book["file_format"],
        },
        "estimated_peak_bytes": sum(item["byte_size"] for item in resources),
        "resources": resources,
    }


def asset_for_id(book_id: str, resource_id: str) -> dict | None:
    return _asset_map(book_id).get(resource_id)
