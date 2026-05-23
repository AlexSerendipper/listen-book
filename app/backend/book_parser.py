import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urldefrag, unquote

from .config import SUPPORTED_FORMATS


@dataclass(frozen=True)
class Chapter:
    title: str
    text: str


@dataclass(frozen=True)
class Paragraph:
    text: str
    text_hash: str


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def make_book_id(path: Path) -> str:
    stat = path.stat()
    raw = f"{path.resolve()}|{stat.st_size}|{int(stat.st_mtime)}"
    return sha1_text(raw)


def parse_book(path: Path) -> tuple[str, list[Chapter]]:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_FORMATS:
        supported = ", ".join(sorted(SUPPORTED_FORMATS))
        raise ValueError(f"Unsupported format {suffix}. Supported: {supported}")
    if suffix == ".md":
        return path.stem, parse_md(path.read_text(encoding="utf-8", errors="replace"))
    if suffix == ".txt":
        return path.stem, parse_txt(path.read_text(encoding="utf-8", errors="replace"))
    return parse_epub(path)


def parse_md(text: str) -> list[Chapter]:
    lines = text.replace("\r\n", "\n").split("\n")
    chapters: list[Chapter] = []
    current_title = "开篇"
    buffer: list[str] = []

    for line in lines:
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if heading and buffer:
            chapters.append(Chapter(current_title, "\n".join(buffer).strip()))
            current_title = heading.group(2).strip()
            buffer = []
        elif heading:
            current_title = heading.group(2).strip()
        else:
            buffer.append(line)

    if buffer:
        chapters.append(Chapter(current_title, "\n".join(buffer).strip()))
    return _non_empty_chapters(chapters)


def parse_txt(text: str) -> list[Chapter]:
    normalized = text.replace("\r\n", "\n")
    lines = normalized.split("\n")
    chapters: list[Chapter] = []
    current_title = "开篇"
    buffer: list[str] = []

    title_pattern = re.compile(
        r"^\s*(第[零一二三四五六七八九十百千万\d]+[章节卷回部篇].{0,40}|Chapter\s+\d+.{0,40})\s*$",
        re.IGNORECASE,
    )
    for line in lines:
        if title_pattern.match(line) and buffer:
            chapters.append(Chapter(current_title, "\n".join(buffer).strip()))
            current_title = line.strip()
            buffer = []
        elif title_pattern.match(line):
            current_title = line.strip()
        else:
            buffer.append(line)

    if buffer:
        chapters.append(Chapter(current_title, "\n".join(buffer).strip()))

    chapters = _non_empty_chapters(chapters)
    if len(chapters) > 1:
        return chapters
    return _split_long_text(normalized)


def parse_epub(path: Path) -> tuple[str, list[Chapter]]:
    try:
        from bs4 import BeautifulSoup
        from ebooklib import ITEM_DOCUMENT, epub
    except ImportError as exc:
        raise RuntimeError("EPUB support requires ebooklib and beautifulsoup4.") from exc

    book = epub.read_epub(str(path))
    title = path.stem
    metadata_title = book.get_metadata("DC", "title")
    if metadata_title and metadata_title[0][0]:
        title = str(metadata_title[0][0])

    spine_items = _epub_spine_documents(book)
    if book.toc:
        chapters = _chapters_from_toc(book.toc, spine_items)
    else:
        chapters = []

    if not chapters:
        chapters = []
        for item in spine_items:
            chapter_title, text = _epub_item_text(item)
            if text:
                chapters.append(Chapter(chapter_title or item.get_name(), text))

    return title, _non_empty_chapters(chapters) or [Chapter(title, "")]


def chunk_chapter(text: str, min_len: int = 700, max_len: int = 900) -> list[Paragraph]:
    raw_parts = [part.strip() for part in re.split(r"\n\s*\n+", text) if part.strip()]
    chunks: list[str] = []
    carry = ""

    for part in raw_parts:
        if carry:
            candidate = f"{carry}\n{part}"
            if len(candidate) <= max_len:
                carry = candidate
                continue
            chunks.extend(_split_paragraph(carry, max_len))
            carry = ""

        if len(part) < min_len:
            carry = part
        elif len(part) <= max_len:
            chunks.append(part)
        else:
            chunks.extend(_split_paragraph(part, max_len))

    if carry:
        chunks.append(carry)

    compacted: list[str] = []
    for chunk in chunks:
        if compacted and len(compacted[-1]) < min_len and len(compacted[-1]) + len(chunk) <= max_len:
            compacted[-1] = f"{compacted[-1]}\n{chunk}"
        else:
            compacted.append(chunk)

    return [Paragraph(text=chunk, text_hash=sha1_text(chunk)) for chunk in compacted if chunk.strip()]


def _split_paragraph(text: str, max_len: int) -> list[str]:
    sentences = re.split(r"(?<=[。！？；!?;])", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_len:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(sentence[i : i + max_len] for i in range(0, len(sentence), max_len))
        elif len(current) + len(sentence) <= max_len:
            current += sentence
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks


def _split_long_text(text: str, target_len: int = 3500) -> list[Chapter]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n+", text) if part.strip()]
    chapters: list[Chapter] = []
    current: list[str] = []
    current_len = 0
    for part in paragraphs:
        current.append(part)
        current_len += len(part)
        if current_len >= target_len:
            chapters.append(Chapter(f"第 {len(chapters) + 1} 部分", "\n\n".join(current)))
            current = []
            current_len = 0
    if current:
        chapters.append(Chapter(f"第 {len(chapters) + 1} 部分", "\n\n".join(current)))
    return chapters or [Chapter("开篇", text.strip())]


def _non_empty_chapters(chapters: list[Chapter]) -> list[Chapter]:
    return [chapter for chapter in chapters if chapter.text.strip()]


def _epub_spine_documents(book) -> list:
    spine_items = []
    seen: set[str] = set()
    for entry in book.spine:
        item_id = entry[0] if isinstance(entry, tuple) else entry
        item = book.get_item_with_id(item_id)
        if item and item.get_name() not in seen:
            seen.add(item.get_name())
            spine_items.append(item)

    if spine_items:
        return spine_items

    try:
        from ebooklib import ITEM_DOCUMENT
    except ImportError:
        return []
    return list(book.get_items_of_type(ITEM_DOCUMENT))


def _chapters_from_toc(toc_nodes, spine_items: list) -> list[Chapter]:
    toc_entries = _flatten_toc(toc_nodes)
    href_to_index = {_normalize_href(item.get_name()): index for index, item in enumerate(spine_items)}
    entries: list[dict] = []

    for entry in toc_entries:
        title = entry["title"]
        href = entry.get("href")
        index = href_to_index.get(_normalize_href(href)) if href else None
        entries.append({"title": title, "index": index, "is_section": not href})

    _infer_section_indices(entries, spine_items)
    entries = [entry for entry in entries if entry["index"] is not None]
    entries.sort(key=lambda entry: entry["index"])

    chapters: list[Chapter] = []
    for position, entry in enumerate(entries):
        start = entry["index"]
        next_indices = [candidate["index"] for candidate in entries[position + 1 :] if candidate["index"] > start]
        end = min(next_indices) if next_indices else len(spine_items)
        text_parts: list[str] = []
        for item in spine_items[start:end]:
            _, text = _epub_item_text(item)
            if text:
                text_parts.append(text)
        text = "\n\n".join(text_parts).strip()
        if text and not _looks_like_non_content(entry["title"], text):
            chapters.append(Chapter(entry["title"], text))
    return chapters


def _flatten_toc(nodes) -> list[dict]:
    entries: list[dict] = []
    for node in nodes:
        if isinstance(node, tuple):
            section, children = node
            title = _node_title(section)
            href = getattr(section, "href", None)
            if title:
                entries.append({"title": title, "href": href})
            entries.extend(_flatten_toc(children))
        else:
            title = _node_title(node)
            href = getattr(node, "href", None)
            if title:
                entries.append({"title": title, "href": href})
    return entries


def _infer_section_indices(entries: list[dict], spine_items: list) -> None:
    for pos, entry in enumerate(entries):
        if entry["index"] is not None:
            continue
        next_known = next((item["index"] for item in entries[pos + 1 :] if item["index"] is not None), None)
        prev_known = next((item["index"] for item in reversed(entries[:pos]) if item["index"] is not None), None)
        start = 0 if prev_known is None else prev_known + 1
        end = len(spine_items) if next_known is None else next_known
        title_key = _compact_text(entry["title"])

        for index in range(start, end):
            heading, text = _epub_item_text(spine_items[index])
            haystack = _compact_text(f"{heading}\n{text[:120]}")
            if title_key and title_key in haystack:
                entry["index"] = index
                break


def _epub_item_text(item) -> tuple[str, str]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(item.get_content(), "html.parser")
    for tag in soup(["script", "style", "nav"]):
        tag.decompose()
    heading = soup.find(["h1", "h2", "h3"])
    title = heading.get_text(" ", strip=True) if heading else ""
    text = soup.get_text("\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text


def _node_title(node) -> str:
    return str(getattr(node, "title", "") or "").strip()


def _normalize_href(href: str | None) -> str:
    if not href:
        return ""
    clean = unquote(urldefrag(href)[0]).replace("\\", "/")
    return clean.lstrip("./")


def _compact_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _looks_like_non_content(title: str, text: str) -> bool:
    compact = _compact_text(f"{title}\n{text}")
    return len(compact) < 80 and any(keyword in compact for keyword in ("封面", "版权页", "图书在版编目"))
