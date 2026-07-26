import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .config import DB_PATH, ensure_dirs


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  title TEXT,
  author TEXT,
  epub_css TEXT NOT NULL DEFAULT '',
  file_format TEXT NOT NULL,
  file_size INTEGER,
  file_mtime INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, chapter_index)
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  html TEXT,
  is_audio INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, chapter_index, paragraph_index)
);

CREATE TABLE IF NOT EXISTS reading_progress (
  book_id TEXT PRIMARY KEY,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  audio_position_ms INTEGER NOT NULL DEFAULT 0,
  has_playback_position INTEGER NOT NULL DEFAULT 0,
  reading_chapter_index INTEGER,
  reading_paragraph_index INTEGER,
  reading_sentence_index INTEGER,
  reading_page_offset INTEGER NOT NULL DEFAULT 0,
  voice TEXT NOT NULL,
  rate TEXT NOT NULL,
  volume TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audio_cache (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  voice TEXT NOT NULL,
  rate TEXT NOT NULL,
  volume TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, chapter_index, paragraph_index, voice, rate, volume, text_hash)
);

CREATE TABLE IF NOT EXISTS sentence_timings (
  id TEXT PRIMARY KEY,
  audio_cache_id TEXT NOT NULL,
  sentence_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  text TEXT,
  FOREIGN KEY(audio_cache_id) REFERENCES audio_cache(id) ON DELETE CASCADE,
  UNIQUE(audio_cache_id, sentence_index)
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None


def init_db(db_path: Path = DB_PATH) -> None:
    ensure_dirs()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "books", "epub_css", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "paragraphs", "html", "TEXT")
        _ensure_column(conn, "paragraphs", "is_audio", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "reading_progress", "has_playback_position", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "reading_progress", "reading_chapter_index", "INTEGER")
        _ensure_column(conn, "reading_progress", "reading_paragraph_index", "INTEGER")
        _ensure_column(conn, "reading_progress", "reading_sentence_index", "INTEGER")
        _ensure_column(conn, "reading_progress", "reading_page_offset", "INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    finally:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
