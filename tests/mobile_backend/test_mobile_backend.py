import asyncio
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from app.backend import main
from app.backend.db import init_db, utc_now
from app.backend.mobile import auth
from app.backend.mobile.catalog import canonical_books, content_sha256, mobile_display_title
from app.backend.mobile.constants import ANCHOR_VERSION, PARSER_VERSION
from app.backend.mobile.migrations import _backfill_missing_epub_authors
from app.backend.mobile.progress import anchor_text_hash, overwrite_desktop


class TemporaryDatabaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db_path = self.root / "app.sqlite"
        init_db(self.db_path)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()


class MobileMigrationTests(TemporaryDatabaseTest):
    def test_migration_is_additive_and_repeatable(self) -> None:
        init_db(self.db_path)
        init_db(self.db_path)
        with self.database() as db:
            book_columns = {row["name"] for row in db.execute("PRAGMA table_info(books)")}
            progress_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(reading_progress)")
            }
            migration_count = db.execute(
                "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1"
            ).fetchone()["count"]
        self.assertIn("content_hash", book_columns)
        self.assertIn("parser_version", book_columns)
        self.assertIn("reading_anchor_text_hash", progress_columns)
        self.assertIn("reading_revision", progress_columns)
        self.assertEqual(migration_count, 1)

    def test_existing_epub_author_is_backfilled_without_reimport(self) -> None:
        source = self.root / "book.epub"
        source.write_bytes(b"epub-placeholder")
        now = utc_now()
        with self.database() as db:
            db.execute(
                """
                INSERT INTO books
                (id, file_path, title, author, file_format, created_at, updated_at)
                VALUES ('book-1', ?, 'Book', NULL, 'epub', ?, ?)
                """,
                (str(source), now, now),
            )
            with patch("app.backend.book_parser.read_epub_author", return_value="测试作者"):
                _backfill_missing_epub_authors(db)
            author = db.execute("SELECT author FROM books WHERE id = 'book-1'").fetchone()["author"]
        self.assertEqual(author, "测试作者")


class MobileCatalogTests(TemporaryDatabaseTest):
    def test_mobile_title_keeps_only_book_name_and_version(self) -> None:
        self.assertEqual(
            mobile_display_title("聪明的投资者（第4版，注疏点评版）（证券投资实务领域经典著作）"),
            "聪明的投资者（第4版，注疏点评版）",
        )
        self.assertEqual(
            mobile_display_title("穷查理宝典（珍藏版）（1+2册）"),
            "穷查理宝典（珍藏版）",
        )
        self.assertEqual(
            mobile_display_title("100个基本:松浦弥太郎的人生信条【宣传简介】"),
            "100个基本",
        )

    def test_content_hash_and_canonical_duplicate_are_stable(self) -> None:
        first = self.root / "first.epub"
        second = self.root / "second.epub"
        first.write_bytes(b"same-book-bytes")
        second.write_bytes(b"same-book-bytes")
        digest = content_sha256(first)
        now = utc_now()
        with self.database() as db:
            for book_id, path, created_at in (
                ("book-b", second, now),
                ("book-a", first, "2020-01-01T00:00:00+00:00"),
            ):
                stat = path.stat()
                db.execute(
                    """
                    INSERT INTO books
                    (id, file_path, title, file_format, file_size, file_mtime, created_at, updated_at)
                    VALUES (?, ?, ?, 'epub', ?, ?, ?, ?)
                    """,
                    (book_id, str(path), book_id, stat.st_size, int(stat.st_mtime), created_at, now),
                )
            books = canonical_books(db)
        self.assertEqual(books[0]["content_hash"], digest)
        self.assertEqual(books[0]["desktop_book_id"], "book-a")
        self.assertEqual(books[0]["duplicate_count"], 1)


class MobileProgressTests(TemporaryDatabaseTest):
    def test_python_anchor_matches_shared_unicode_vectors(self) -> None:
        vector_path = Path(__file__).parents[1] / "mobile_frontend" / "anchor-vectors.json"
        vectors = json.loads(vector_path.read_text(encoding="utf-8"))
        for vector in vectors:
            self.assertEqual(
                anchor_text_hash(vector["text"], vector["offset"]), vector["sha256"]
            )

    def test_mobile_overwrite_preserves_all_playback_fields_and_is_idempotent(self) -> None:
        source = self.root / "book.epub"
        source.write_bytes(b"book")
        digest = content_sha256(source)
        now = utc_now()
        text = "这是用于验证移动文字进度覆盖的段落。下一句话保持在同一段。"
        with self.database() as db:
            db.execute(
                """
                INSERT INTO books
                (id, file_path, title, file_format, file_size, file_mtime, created_at, updated_at,
                 content_hash, parser_version)
                VALUES ('book-1', ?, 'Book', 'epub', 4, 1, ?, ?, ?, ?)
                """,
                (str(source), now, now, digest, PARSER_VERSION),
            )
            db.execute(
                "INSERT INTO chapters (id, book_id, chapter_index, title, text) VALUES ('c', 'book-1', 0, 'C', ?)",
                (text,),
            )
            db.execute(
                """
                INSERT INTO paragraphs
                (id, book_id, chapter_index, paragraph_index, text, text_hash, html, is_audio)
                VALUES ('p', 'book-1', 0, 0, ?, 'old', NULL, 1)
                """,
                (text,),
            )
            db.execute(
                """
                INSERT INTO reading_progress
                (book_id, chapter_index, paragraph_index, audio_position_ms, has_playback_position,
                 reading_chapter_index, reading_paragraph_index, reading_sentence_index,
                 reading_page_offset, voice, rate, volume, updated_at, reading_revision)
                VALUES ('book-1', 7, 8, 9876, 1, 0, 0, 0, 0, 'voice-x', '+25%', '-10%', ?, 0)
                """,
                (now,),
            )

        anchor = {
            "book_content_hash": digest,
            "parser_version": PARSER_VERSION,
            "chapter_index": 0,
            "paragraph_index": 0,
            "character_offset": 2,
            "anchor_text_hash": anchor_text_hash(text, 2),
            "anchor_asset_id": None,
            "anchor_version": ANCHOR_VERSION,
            "client_updated_at": now,
        }
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            first = overwrite_desktop(
                db,
                device_id="iphone-1234567890",
                content_hash=digest,
                anchor=anchor,
                target_revision=0,
                operation_id="operation-1234567890",
            )
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            repeated = overwrite_desktop(
                db,
                device_id="iphone-1234567890",
                content_hash=digest,
                anchor=anchor,
                target_revision=0,
                operation_id="operation-1234567890",
            )
            row = db.execute("SELECT * FROM reading_progress WHERE book_id = 'book-1'").fetchone()
        self.assertEqual(first, repeated)
        self.assertEqual(row["chapter_index"], 7)
        self.assertEqual(row["paragraph_index"], 8)
        self.assertEqual(row["audio_position_ms"], 9876)
        self.assertEqual(row["voice"], "voice-x")
        self.assertEqual(row["rate"], "+25%")
        self.assertEqual(row["volume"], "-10%")
        self.assertEqual(row["reading_character_offset"], 2)
        self.assertEqual(row["reading_revision"], 1)


class MobilePairingTests(TemporaryDatabaseTest):
    def test_pairing_claim_is_repeatable_until_ack_then_closes(self) -> None:
        secret_path = self.root / "mobile-secret"
        patches = (
            patch("app.backend.mobile.auth.get_db", self.database),
            patch("app.backend.mobile.auth.SECRET_PATH", secret_path),
            patch("app.backend.mobile.auth.DATA_DIR", self.root),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        started = auth.start_pairing()
        pending = auth.request_pairing(
            started["short_code"], "iphone-1234567890", "Test iPhone"
        )
        auth.confirm_pairing(started["session_id"])
        first = auth.claim_credential(pending["session_id"], pending["poll_secret"])
        second = auth.claim_credential(pending["session_id"], pending["poll_secret"])
        self.assertEqual(first["credential"], second["credential"])
        identity = auth.authenticate_token(first["credential"], self.db_path)
        self.assertEqual(identity.device_id, "iphone-1234567890")
        auth.ack_credential(pending["session_id"], pending["poll_secret"])
        with self.assertRaises(Exception):
            auth.claim_credential(pending["session_id"], pending["poll_secret"])


class MobileBoundaryTests(unittest.TestCase):
    @staticmethod
    async def request(path: str) -> tuple[int, dict[str, str]]:
        messages = []
        sent_request = False

        async def receive():
            nonlocal sent_request
            if not sent_request:
                sent_request = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"host", b"127.0.0.1:8765"),
                (b"x-forwarded-proto", b"https"),
                (b"x-forwarded-for", b"100.64.0.2"),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8765),
        }
        await main.app(scope, receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        headers = {key.decode().lower(): value.decode() for key, value in start["headers"]}
        return start["status"], headers

    def test_forwarded_requests_only_reach_mobile_allowlist(self) -> None:
        for path in ("/app/", "/api/books", "/mobile-admin/"):
            status, _ = asyncio.run(self.request(path))
            self.assertEqual(status, 404)
        status, headers = asyncio.run(self.request("/mobile/"))
        self.assertEqual(status, 200)
        self.assertIn("content-security-policy", headers)
        status, _ = asyncio.run(self.request("/api/mobile/health"))
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
