import hashlib
import json
import sqlite3
import unicodedata

from fastapi import HTTPException

from ..db import utc_now
from .catalog import canonical_book
from .constants import ANCHOR_VERSION, PARSER_VERSION


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))


def anchor_text_hash(text: str, offset: int) -> str:
    normalized = normalize_text(text)
    length = len(normalized)
    start = min(max(offset - 32, 0), max(length - 64, 0))
    window = normalized[start : min(start + 64, length)]
    return hashlib.sha256(window.encode("utf-8")).hexdigest()


def _anchor_from_row(row: sqlite3.Row, content_hash: str) -> dict | None:
    if row["reading_chapter_index"] is None or row["reading_paragraph_index"] is None:
        return None
    return {
        "book_content_hash": content_hash,
        "parser_version": row["reading_parser_version"] or PARSER_VERSION,
        "chapter_index": row["reading_chapter_index"],
        "paragraph_index": row["reading_paragraph_index"],
        "character_offset": row["reading_character_offset"] or 0,
        "anchor_text_hash": row["reading_anchor_text_hash"],
        "anchor_asset_id": row["reading_anchor_asset_id"],
        "anchor_version": row["reading_anchor_version"] or ANCHOR_VERSION,
        "client_updated_at": row["reading_updated_at"] or row["updated_at"],
    }


def _validate_anchor(conn: sqlite3.Connection, book: sqlite3.Row, anchor: dict) -> dict:
    if anchor.get("book_content_hash") != book["content_hash"]:
        raise HTTPException(status_code=409, detail="book_content_hash_mismatch")
    if (
        anchor.get("parser_version") != PARSER_VERSION
        or anchor.get("anchor_version") != ANCHOR_VERSION
    ):
        raise HTTPException(status_code=409, detail="parser_version_mismatch")
    row = conn.execute(
        """
        SELECT text FROM paragraphs
        WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
        """,
        (book["id"], anchor["chapter_index"], anchor["paragraph_index"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=422, detail="invalid_source_anchor")
    text = normalize_text(row["text"] or "")
    offset = anchor["character_offset"]
    if offset < 0 or offset > len(text):
        raise HTTPException(status_code=422, detail="invalid_source_anchor")
    expected = anchor_text_hash(text, offset)
    if not anchor.get("anchor_asset_id") and not anchor.get("anchor_text_hash"):
        raise HTTPException(status_code=422, detail="invalid_source_anchor")
    if anchor.get("anchor_text_hash") and anchor["anchor_text_hash"] != expected:
        raise HTTPException(status_code=422, detail="invalid_source_anchor")
    clean = dict(anchor)
    clean["anchor_text_hash"] = expected
    clean["client_updated_at"] = clean.get("client_updated_at") or utc_now()
    return clean


def ensure_desktop_anchor(conn: sqlite3.Connection, book: sqlite3.Row) -> tuple[dict | None, int]:
    row = conn.execute(
        "SELECT * FROM reading_progress WHERE book_id = ?", (book["id"],)
    ).fetchone()
    if not row:
        return None, 0
    anchor = _anchor_from_row(row, book["content_hash"])
    if not anchor:
        return None, int(row["reading_revision"] or 0)
    if not anchor["anchor_text_hash"] or anchor["parser_version"] != PARSER_VERSION:
        paragraph = conn.execute(
            """
            SELECT text FROM paragraphs
            WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
            """,
            (book["id"], anchor["chapter_index"], anchor["paragraph_index"]),
        ).fetchone()
        if not paragraph:
            return None, int(row["reading_revision"] or 0)
        anchor["character_offset"] = 0
        anchor["anchor_text_hash"] = anchor_text_hash(paragraph["text"] or "", 0)
        anchor["parser_version"] = PARSER_VERSION
        anchor["anchor_version"] = ANCHOR_VERSION
        anchor["client_updated_at"] = row["reading_updated_at"] or row["updated_at"]
        conn.execute(
            """
            UPDATE reading_progress SET
              reading_character_offset = 0,
              reading_anchor_text_hash = ?,
              reading_parser_version = ?,
              reading_anchor_version = ?,
              reading_updated_at = COALESCE(reading_updated_at, updated_at),
              reading_revision = reading_revision + 1
            WHERE book_id = ?
            """,
            (anchor["anchor_text_hash"], PARSER_VERSION, ANCHOR_VERSION, book["id"]),
        )
        return anchor, int(row["reading_revision"] or 0) + 1
    return anchor, int(row["reading_revision"] or 0)


def preview(conn: sqlite3.Connection, content_hash: str) -> dict:
    book = canonical_book(conn, content_hash)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    anchor, revision = ensure_desktop_anchor(conn, book)
    nearby = None
    if anchor:
        row = conn.execute(
            """
            SELECT text FROM paragraphs
            WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
            """,
            (book["id"], anchor["chapter_index"], anchor["paragraph_index"]),
        ).fetchone()
        nearby = (row["text"] or "")[:120] if row else None
    return {
        "content_hash": content_hash,
        "parser_version": PARSER_VERSION,
        "anchor_version": ANCHOR_VERSION,
        "desktop": {"anchor": anchor, "revision": revision, "nearby_text": nearby},
    }


def overwrite_desktop(
    conn: sqlite3.Connection,
    *,
    device_id: str,
    content_hash: str,
    anchor: dict,
    target_revision: int,
    operation_id: str,
) -> dict:
    previous_operation = conn.execute(
        "SELECT result_json FROM mobile_operations WHERE operation_id = ?", (operation_id,)
    ).fetchone()
    if previous_operation:
        return json.loads(previous_operation["result_json"])
    book = canonical_book(conn, content_hash)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    clean = _validate_anchor(conn, book, anchor)
    row = conn.execute(
        "SELECT * FROM reading_progress WHERE book_id = ?", (book["id"],)
    ).fetchone()
    current_revision = int(row["reading_revision"] or 0) if row else 0
    if current_revision != target_revision:
        raise HTTPException(status_code=409, detail="target_revision_conflict")
    old_anchor = _anchor_from_row(row, content_hash) if row else None
    now = utc_now()
    conn.execute(
        """
        INSERT INTO progress_history
        (book_id, target_device_id, anchor_json, revision, consumed_at, created_at)
        VALUES (?, 'desktop', ?, ?, NULL, ?)
        ON CONFLICT(book_id, target_device_id) DO UPDATE SET
          anchor_json = excluded.anchor_json,
          revision = excluded.revision,
          consumed_at = NULL,
          created_at = excluded.created_at
        """,
        (book["id"], json.dumps(old_anchor), current_revision, now),
    )
    if row:
        conn.execute(
            """
            UPDATE reading_progress SET
              reading_chapter_index = ?, reading_paragraph_index = ?,
              reading_sentence_index = NULL, reading_page_offset = 0,
              reading_character_offset = ?, reading_anchor_text_hash = ?,
              reading_anchor_asset_id = ?, reading_parser_version = ?,
              reading_anchor_version = ?, reading_updated_at = ?,
              reading_revision = reading_revision + 1
            WHERE book_id = ?
            """,
            (
                clean["chapter_index"], clean["paragraph_index"], clean["character_offset"],
                clean["anchor_text_hash"], clean.get("anchor_asset_id"), PARSER_VERSION,
                ANCHOR_VERSION, clean["client_updated_at"], book["id"],
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO reading_progress
            (book_id, chapter_index, paragraph_index, audio_position_ms, has_playback_position,
             reading_chapter_index, reading_paragraph_index, reading_sentence_index,
             reading_page_offset, voice, rate, volume, updated_at,
             reading_character_offset, reading_anchor_text_hash, reading_anchor_asset_id,
             reading_parser_version, reading_anchor_version, reading_updated_at, reading_revision)
            VALUES (?, 0, 0, 0, 0, ?, ?, NULL, 0, '', '+0%', '+0%', ?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                book["id"], clean["chapter_index"], clean["paragraph_index"], now,
                clean["character_offset"], clean["anchor_text_hash"], clean.get("anchor_asset_id"),
                PARSER_VERSION, ANCHOR_VERSION, clean["client_updated_at"],
            ),
        )
    result = {"status": "overwritten", "revision": current_revision + 1, "anchor": clean}
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    conn.execute(
        """
        INSERT INTO mobile_operations
        (operation_id, device_id, content_hash, direction, result_json, created_at)
        VALUES (?, ?, ?, 'mobile_to_desktop', ?, ?)
        """,
        (operation_id, device_id, content_hash, encoded, now),
    )
    return result
