import shutil
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .book_parser import chunk_chapter, make_book_id, parse_book
from .config import (
    CHINESE_VOICES,
    DATA_DIR,
    DEFAULT_RATE,
    DEFAULT_VOICE,
    DEFAULT_VOLUME,
    FRONTEND_DIR,
    SUPPORTED_FORMATS,
    ensure_dirs,
)
from .db import get_db, init_db, row_to_dict, utc_now
from .tts import audio_path, generate_audio_with_sentence_timings


app = FastAPI(title="Local Audiobook Reader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    ensure_dirs()
    init_db()


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse("/app/")


@app.get("/api/voices")
def voices() -> dict:
    return {
        "default": DEFAULT_VOICE,
        "voices": CHINESE_VOICES,
        "rate": DEFAULT_RATE,
        "volume": DEFAULT_VOLUME,
    }


@app.get("/api/books")
def list_books() -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            """
            SELECT b.*,
                   rp.chapter_index AS progress_chapter_index,
                   rp.paragraph_index AS progress_paragraph_index,
                   rp.updated_at AS progress_updated_at
            FROM books b
            LEFT JOIN reading_progress rp ON rp.book_id = b.id
            ORDER BY COALESCE(rp.updated_at, b.updated_at) DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/books/recent")
def recent_book() -> dict | None:
    with get_db() as db:
        row = db.execute(
            """
            SELECT b.*, rp.chapter_index, rp.paragraph_index, rp.audio_position_ms,
                   rp.voice, rp.rate, rp.volume, rp.updated_at AS progress_updated_at
            FROM reading_progress rp
            JOIN books b ON b.id = rp.book_id
            ORDER BY rp.updated_at DESC
            LIMIT 1
            """
        ).fetchone()
    return row_to_dict(row)


@app.post("/api/books/import")
async def import_book(
    file_path: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
) -> dict:
    path = await _resolve_import_path(file_path, file)
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    try:
        title, chapters = parse_book(path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    book_id = make_book_id(path)
    stat = path.stat()
    now = utc_now()

    with get_db() as db:
        existing = db.execute("SELECT created_at FROM books WHERE id = ?", (book_id,)).fetchone()
        db.execute(
            """
            INSERT OR REPLACE INTO books
            (id, file_path, title, author, file_format, file_size, file_mtime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                book_id,
                str(path),
                title,
                None,
                suffix.lstrip("."),
                stat.st_size,
                int(stat.st_mtime),
                existing["created_at"] if existing else now,
                now,
            ),
        )
        db.execute("DELETE FROM chapters WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM paragraphs WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM audio_cache WHERE book_id = ?", (book_id,))
        for chapter_index, chapter in enumerate(chapters):
            db.execute(
                """
                INSERT INTO chapters (id, book_id, chapter_index, title, text)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(uuid.uuid4()), book_id, chapter_index, chapter.title, chapter.text),
            )
            for paragraph_index, paragraph in enumerate(chunk_chapter(chapter.text)):
                db.execute(
                    """
                    INSERT INTO paragraphs
                    (id, book_id, chapter_index, paragraph_index, text, text_hash)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        book_id,
                        chapter_index,
                        paragraph_index,
                        paragraph.text,
                        paragraph.text_hash,
                    ),
                )

    return get_book(book_id)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str) -> dict:
    with get_db() as db:
        book = db.execute("SELECT file_path FROM books WHERE id = ?", (book_id,)).fetchone()
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        cache_rows = db.execute("SELECT id FROM audio_cache WHERE book_id = ?", (book_id,)).fetchall()
        for cache_row in cache_rows:
            db.execute("DELETE FROM sentence_timings WHERE audio_cache_id = ?", (cache_row["id"],))
        db.execute("DELETE FROM audio_cache WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM reading_progress WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM paragraphs WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM chapters WHERE book_id = ?", (book_id,))
        db.execute("DELETE FROM books WHERE id = ?", (book_id,))

    audio_dir = (DATA_DIR.parent / "cache" / "audio" / book_id).resolve()
    if audio_dir.exists():
        shutil.rmtree(audio_dir)

    stored_book_path = Path(book["file_path"]).resolve()
    books_dir = (DATA_DIR / "books").resolve()
    try:
        if stored_book_path.is_file() and stored_book_path.is_relative_to(books_dir):
            stored_book_path.unlink()
    except OSError:
        pass

    return {"deleted": True, "book_id": book_id}


@app.get("/api/books/{book_id}")
def get_book(book_id: str) -> dict:
    with get_db() as db:
        book = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        chapter_count = db.execute(
            "SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?", (book_id,)
        ).fetchone()["count"]
        paragraph_count = db.execute(
            "SELECT COUNT(*) AS count FROM paragraphs WHERE book_id = ?", (book_id,)
        ).fetchone()["count"]
    data = dict(book)
    data["chapter_count"] = chapter_count
    data["paragraph_count"] = paragraph_count
    return data


@app.get("/api/books/{book_id}/chapters")
def get_chapters(book_id: str) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            """
            SELECT c.chapter_index, c.title, COUNT(p.id) AS paragraph_count
            FROM chapters c
            LEFT JOIN paragraphs p
              ON p.book_id = c.book_id AND p.chapter_index = c.chapter_index
            WHERE c.book_id = ?
            GROUP BY c.id, c.chapter_index, c.title
            ORDER BY c.chapter_index
            """,
            (book_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/books/{book_id}/paragraphs")
def get_paragraphs(book_id: str, chapter_index: int = Query(ge=0)) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            """
            SELECT chapter_index, paragraph_index, text, text_hash
            FROM paragraphs
            WHERE book_id = ? AND chapter_index = ?
            ORDER BY paragraph_index
            """,
            (book_id, chapter_index),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/books/{book_id}/progress")
def get_progress(book_id: str) -> dict:
    with get_db() as db:
        row = db.execute("SELECT * FROM reading_progress WHERE book_id = ?", (book_id,)).fetchone()
    return row_to_dict(row) or {
        "book_id": book_id,
        "chapter_index": 0,
        "paragraph_index": 0,
        "audio_position_ms": 0,
        "voice": DEFAULT_VOICE,
        "rate": DEFAULT_RATE,
        "volume": DEFAULT_VOLUME,
    }


@app.post("/api/books/{book_id}/progress")
def save_progress(book_id: str, payload: dict) -> dict:
    chapter_index = int(payload.get("chapter_index", 0))
    paragraph_index = int(payload.get("paragraph_index", 0))
    audio_position_ms = int(payload.get("audio_position_ms", 0))
    voice = str(payload.get("voice") or DEFAULT_VOICE)
    rate = str(payload.get("rate") or DEFAULT_RATE)
    volume = str(payload.get("volume") or DEFAULT_VOLUME)
    now = utc_now()

    with get_db() as db:
        if not db.execute("SELECT 1 FROM books WHERE id = ?", (book_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Book not found")
        db.execute(
            """
            INSERT OR REPLACE INTO reading_progress
            (book_id, chapter_index, paragraph_index, audio_position_ms, voice, rate, volume, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (book_id, chapter_index, paragraph_index, audio_position_ms, voice, rate, volume, now),
        )
    return get_progress(book_id)


@app.get("/api/books/{book_id}/audio")
async def get_audio(
    book_id: str,
    chapter_index: int = Query(ge=0),
    paragraph_index: int = Query(ge=0),
    voice: str = DEFAULT_VOICE,
    rate: str = DEFAULT_RATE,
    volume: str = DEFAULT_VOLUME,
) -> FileResponse:
    target = await ensure_audio_cache(book_id, chapter_index, paragraph_index, voice, rate, volume)
    return FileResponse(target, media_type="audio/mpeg", filename=target.name)


@app.post("/api/books/{book_id}/prefetch-audio")
async def prefetch_audio(book_id: str, payload: dict) -> dict:
    chapter_index = int(payload.get("chapter_index", 0))
    paragraph_index = int(payload.get("paragraph_index", 0))
    voice = str(payload.get("voice") or DEFAULT_VOICE)
    rate = str(payload.get("rate") or DEFAULT_RATE)
    volume = str(payload.get("volume") or DEFAULT_VOLUME)
    await ensure_audio_cache(book_id, chapter_index, paragraph_index, voice, rate, volume)
    return {"prefetched": True}


async def ensure_audio_cache(
    book_id: str,
    chapter_index: int,
    paragraph_index: int,
    voice: str,
    rate: str,
    volume: str,
) -> Path:
    with get_db() as db:
        paragraph = db.execute(
            """
            SELECT text, text_hash
            FROM paragraphs
            WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
            """,
            (book_id, chapter_index, paragraph_index),
        ).fetchone()
        if not paragraph:
            raise HTTPException(status_code=404, detail="Paragraph not found")

        cached = db.execute(
            """
            SELECT id, file_path FROM audio_cache
            WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
              AND voice = ? AND rate = ? AND volume = ? AND text_hash = ?
            """,
            (book_id, chapter_index, paragraph_index, voice, rate, volume, paragraph["text_hash"]),
        ).fetchone()

    target = None
    cache_id = None
    if cached:
        cached_path = Path(cached["file_path"])
        if cached_path.exists():
            target = cached_path
            cache_id = cached["id"]
        else:
            with get_db() as db:
                db.execute("DELETE FROM sentence_timings WHERE audio_cache_id = ?", (cached["id"],))
                db.execute("DELETE FROM audio_cache WHERE id = ?", (cached["id"],))

    if target is None:
        target = audio_path(
            book_id, chapter_index, paragraph_index, voice, rate, volume, paragraph["text_hash"]
        )
        if target.exists():
            target.unlink()

    if not target.exists():
        try:
            timings = await generate_audio_with_sentence_timings(
                paragraph["text"], target, voice, rate, volume
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    else:
        timings = []

    with get_db() as db:
        cache_id = cache_id or str(uuid.uuid4())
        db.execute(
            """
            INSERT OR IGNORE INTO audio_cache
            (id, book_id, chapter_index, paragraph_index, voice, rate, volume, text_hash, file_path, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cache_id,
                book_id,
                chapter_index,
                paragraph_index,
                voice,
                rate,
                volume,
                paragraph["text_hash"],
                str(target),
                None,
                utc_now(),
            ),
        )
        for sentence_index, timing in enumerate(timings):
            db.execute(
                """
                INSERT OR IGNORE INTO sentence_timings
                (id, audio_cache_id, sentence_index, start_ms, duration_ms, text)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    cache_id,
                    sentence_index,
                    timing["start_ms"],
                    timing["duration_ms"],
                    timing["text"],
                ),
            )

    return target


@app.get("/api/books/{book_id}/sentence-timings")
def get_sentence_timings(
    book_id: str,
    chapter_index: int = Query(ge=0),
    paragraph_index: int = Query(ge=0),
    voice: str = DEFAULT_VOICE,
    rate: str = DEFAULT_RATE,
    volume: str = DEFAULT_VOLUME,
) -> list[dict]:
    with get_db() as db:
        paragraph = db.execute(
            """
            SELECT text_hash
            FROM paragraphs
            WHERE book_id = ? AND chapter_index = ? AND paragraph_index = ?
            """,
            (book_id, chapter_index, paragraph_index),
        ).fetchone()
        if not paragraph:
            raise HTTPException(status_code=404, detail="Paragraph not found")
        rows = db.execute(
            """
            SELECT st.sentence_index, st.start_ms, st.duration_ms, st.text
            FROM audio_cache ac
            JOIN sentence_timings st ON st.audio_cache_id = ac.id
            WHERE ac.book_id = ? AND ac.chapter_index = ? AND ac.paragraph_index = ?
              AND ac.voice = ? AND ac.rate = ? AND ac.volume = ? AND ac.text_hash = ?
            ORDER BY st.sentence_index
            """,
            (book_id, chapter_index, paragraph_index, voice, rate, volume, paragraph["text_hash"]),
        ).fetchall()
    return [dict(row) for row in rows]


async def _resolve_import_path(file_path: str | None, file: UploadFile | None) -> Path:
    if file and file.filename:
        suffix = Path(file.filename).suffix.lower()
        if suffix not in SUPPORTED_FORMATS:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")
        upload_dir = DATA_DIR / "books"
        upload_dir.mkdir(parents=True, exist_ok=True)
        target = upload_dir / f"{uuid.uuid4().hex}{suffix}"
        with target.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        return target

    if file_path:
        path = Path(file_path).expanduser()
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=400, detail="File path does not exist")
        return path

    raise HTTPException(status_code=400, detail="Provide a file upload or file_path")


if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
