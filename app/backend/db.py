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
  FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, chapter_index, paragraph_index)
);

CREATE TABLE IF NOT EXISTS reading_progress (
  book_id TEXT PRIMARY KEY,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  audio_position_ms INTEGER NOT NULL DEFAULT 0,
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
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)
        conn.commit()


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
