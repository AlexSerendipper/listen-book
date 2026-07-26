import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from app.backend import main
from app.backend.db import init_db, utc_now


class ReadingProgressTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "reader.sqlite"
        init_db(self.db_path)
        db = sqlite3.connect(self.db_path)
        try:
            now = utc_now()
            db.execute(
                """
                INSERT INTO books
                (id, file_path, title, author, file_format, file_size, file_mtime, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("book-1", "book.txt", "Book", None, "txt", 1, 1, now, now),
            )
            db.commit()
        finally:
            db.close()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @contextmanager
    def get_test_db(self):
        db = sqlite3.connect(self.db_path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def test_progress_round_trip_keeps_playback_and_reading_positions(self) -> None:
        payload = {
            "chapter_index": 2,
            "paragraph_index": 4,
            "audio_position_ms": 1234,
            "has_playback_position": True,
            "reading_chapter_index": 5,
            "reading_paragraph_index": 7,
            "reading_sentence_index": 3,
            "reading_page_offset": 1,
            "voice": "voice",
            "rate": "+0%",
            "volume": "+0%",
        }
        with patch("app.backend.main.get_db", self.get_test_db):
            saved = main.save_progress("book-1", payload)

        self.assertEqual(saved["chapter_index"], 2)
        self.assertEqual(saved["paragraph_index"], 4)
        self.assertEqual(saved["has_playback_position"], 1)
        self.assertEqual(saved["reading_chapter_index"], 5)
        self.assertEqual(saved["reading_paragraph_index"], 7)
        self.assertEqual(saved["reading_sentence_index"], 3)
        self.assertEqual(saved["reading_page_offset"], 1)

        legacy_payload = {
            "chapter_index": 2,
            "paragraph_index": 5,
            "audio_position_ms": 2345,
            "voice": "voice",
            "rate": "+0%",
            "volume": "+0%",
        }
        with patch("app.backend.main.get_db", self.get_test_db):
            preserved = main.save_progress("book-1", legacy_payload)
        self.assertEqual(preserved["has_playback_position"], 1)
        self.assertEqual(preserved["reading_chapter_index"], 5)
        self.assertEqual(preserved["reading_paragraph_index"], 7)

    def test_old_progress_schema_migrates_as_existing_playback(self) -> None:
        legacy_path = Path(self.temp_dir.name) / "legacy.sqlite"
        db = sqlite3.connect(legacy_path)
        try:
            db.execute(
                """
                CREATE TABLE reading_progress (
                  book_id TEXT PRIMARY KEY,
                  chapter_index INTEGER NOT NULL,
                  paragraph_index INTEGER NOT NULL,
                  audio_position_ms INTEGER NOT NULL DEFAULT 0,
                  voice TEXT NOT NULL,
                  rate TEXT NOT NULL,
                  volume TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            db.execute(
                "INSERT INTO reading_progress VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("legacy", 1, 2, 0, "voice", "+0%", "+0%", utc_now()),
            )
            db.commit()
        finally:
            db.close()

        init_db(legacy_path)

        db = sqlite3.connect(legacy_path)
        try:
            row = db.execute(
                "SELECT has_playback_position, reading_page_offset FROM reading_progress"
            ).fetchone()
        finally:
            db.close()
        self.assertEqual(row, (1, 0))


if __name__ == "__main__":
    unittest.main()
