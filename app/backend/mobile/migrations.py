import sqlite3
from pathlib import Path


MIGRATION_VERSION = 2


def _ensure_column(
    conn: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def run_mobile_migrations(conn: sqlite3.Connection) -> None:
    """Apply additive mobile migrations in one restart-safe transaction."""
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            )
            """
        )
        applied = conn.execute(
            "SELECT 1 FROM schema_migrations WHERE version = ?", (MIGRATION_VERSION,)
        ).fetchone()
        if applied:
            conn.commit()
            return

        _ensure_column(conn, "books", "content_hash", "TEXT")
        _ensure_column(conn, "books", "parser_version", "TEXT")
        _ensure_column(conn, "reading_progress", "reading_character_offset", "INTEGER")
        _ensure_column(conn, "reading_progress", "reading_anchor_text_hash", "TEXT")
        _ensure_column(conn, "reading_progress", "reading_anchor_asset_id", "TEXT")
        _ensure_column(conn, "reading_progress", "reading_parser_version", "TEXT")
        _ensure_column(
            conn, "reading_progress", "reading_anchor_version", "INTEGER NOT NULL DEFAULT 1"
        )
        _ensure_column(conn, "reading_progress", "reading_updated_at", "TEXT")
        _ensure_column(
            conn, "reading_progress", "reading_revision", "INTEGER NOT NULL DEFAULT 0"
        )

        statements = (
            "CREATE INDEX IF NOT EXISTS idx_books_content_hash ON books(content_hash)",
            """
            CREATE TABLE IF NOT EXISTS mobile_devices (
              device_id TEXT PRIMARY KEY,
              device_name TEXT NOT NULL,
              credential_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_seen_at TEXT,
              revoked_at TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS mobile_pairing_sessions (
              id TEXT PRIMARY KEY,
              code_hash TEXT NOT NULL UNIQUE,
              expires_at REAL NOT NULL,
              consumed_at TEXT,
              device_id TEXT,
              device_name TEXT,
              poll_secret_hash TEXT,
              credential_salt TEXT,
              confirmed_at TEXT,
              acked_at TEXT,
              rejected_at TEXT,
              created_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS mobile_operations (
              operation_id TEXT PRIMARY KEY,
              device_id TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              direction TEXT NOT NULL,
              result_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS progress_history (
              book_id TEXT NOT NULL,
              target_device_id TEXT NOT NULL,
              anchor_json TEXT NOT NULL,
              revision INTEGER NOT NULL,
              consumed_at TEXT,
              created_at TEXT NOT NULL,
              PRIMARY KEY (book_id, target_device_id),
              FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS mobile_security_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_type TEXT NOT NULL,
              result_code TEXT NOT NULL,
              device_hint TEXT,
              operation_id TEXT,
              created_at TEXT NOT NULL
            )
            """,
        )
        for statement in statements:
            conn.execute(statement)
        _backfill_missing_epub_authors(conn)
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))"
        )
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
            (MIGRATION_VERSION,),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _backfill_missing_epub_authors(conn: sqlite3.Connection) -> None:
    from ..book_parser import read_epub_author

    rows = conn.execute(
        """
        SELECT id, file_path FROM books
        WHERE file_format = 'epub' AND (author IS NULL OR trim(author) = '')
        """
    ).fetchall()
    for row in rows:
        path = Path(row[1])
        if not path.is_file():
            continue
        try:
            author = read_epub_author(path)
        except Exception:
            continue
        if author:
            conn.execute("UPDATE books SET author = ? WHERE id = ?", (author, row[0]))
