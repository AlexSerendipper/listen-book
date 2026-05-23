import re
from pathlib import Path

from .config import AUDIO_CACHE_DIR


def safe_audio_name(
    paragraph_index: int,
    voice: str,
    rate: str,
    volume: str,
    text_hash: str,
) -> str:
    raw = f"{paragraph_index}_{voice}_{rate}_{volume}_{text_hash}.mp3"
    return re.sub(r"[^A-Za-z0-9_.%-]+", "_", raw)


def audio_path(
    book_id: str,
    chapter_index: int,
    paragraph_index: int,
    voice: str,
    rate: str,
    volume: str,
    text_hash: str,
) -> Path:
    folder = AUDIO_CACHE_DIR / book_id / str(chapter_index)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / safe_audio_name(paragraph_index, voice, rate, volume, text_hash)


async def generate_audio(text: str, target: Path, voice: str, rate: str, volume: str) -> None:
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError("edge-tts is not installed. Run: pip install -r requirements.txt") from exc

    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, volume=volume)
    await communicate.save(str(target))


async def generate_audio_with_sentence_timings(
    text: str,
    target: Path,
    voice: str,
    rate: str,
    volume: str,
) -> list[dict]:
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError("edge-tts is not installed. Run: pip install -r requirements.txt") from exc

    timings: list[dict] = []
    try:
        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=rate,
            volume=volume,
            boundary="SentenceBoundary",
        )
        with target.open("wb") as audio_file:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_file.write(chunk["data"])
                elif chunk["type"] == "SentenceBoundary":
                    timings.append(
                        {
                            "start_ms": int(chunk.get("offset", 0) / 10_000),
                            "duration_ms": int(chunk.get("duration", 0) / 10_000),
                            "text": chunk.get("text", ""),
                        }
                    )
    except Exception:
        if target.exists():
            target.unlink()
        communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, volume=volume)
        await communicate.save(str(target))
        return []
    return timings
