import hashlib
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urldefrag, unquote, urlparse

from .config import SUPPORTED_FORMATS


@dataclass(frozen=True)
class Chapter:
    title: str
    text: str
    paragraphs: list["Paragraph"] | None = None


@dataclass(frozen=True)
class Paragraph:
    text: str
    text_hash: str
    html: str | None = None
    is_audio: bool = True


@dataclass(frozen=True)
class ParsedBook:
    title: str
    chapters: list[Chapter]
    epub_css: str = ""


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def make_book_id(path: Path) -> str:
    stat = path.stat()
    raw = f"{path.resolve()}|{stat.st_size}|{int(stat.st_mtime)}"
    return sha1_text(raw)


def parse_book(path: Path, book_id: str | None = None, assets_dir: Path | None = None) -> ParsedBook:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_FORMATS:
        supported = ", ".join(sorted(SUPPORTED_FORMATS))
        raise ValueError(f"Unsupported format {suffix}. Supported: {supported}")
    if suffix == ".md":
        return ParsedBook(path.stem, parse_md(path.read_text(encoding="utf-8", errors="replace")))
    if suffix == ".txt":
        return ParsedBook(path.stem, parse_txt(path.read_text(encoding="utf-8", errors="replace")))
    return parse_epub(path, book_id=book_id, assets_dir=assets_dir)


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


def parse_epub(path: Path, book_id: str | None = None, assets_dir: Path | None = None) -> ParsedBook:
    try:
        from bs4 import BeautifulSoup
        from ebooklib import ITEM_DOCUMENT, ITEM_STYLE, epub
    except ImportError as exc:
        raise RuntimeError("EPUB support requires ebooklib and beautifulsoup4.") from exc

    book = epub.read_epub(str(path))
    title = path.stem
    metadata_title = book.get_metadata("DC", "title")
    if metadata_title and metadata_title[0][0]:
        title = str(metadata_title[0][0])

    spine_items = _epub_spine_documents(book)
    if book.toc:
        chapters = _chapters_from_toc(book, book.toc, spine_items, book_id, assets_dir)
    else:
        chapters = []

    if not chapters:
        chapters = []
        for item in spine_items:
            chapter_title, text = _epub_item_text(item)
            raw_paragraphs = _epub_item_paragraphs(book, item, book_id, assets_dir)
            if text or raw_paragraphs:
                paragraphs = chunk_paragraphs(raw_paragraphs)
                chapters.append(Chapter(chapter_title or item.get_name(), text, paragraphs))

    css = "\n".join(
        _scope_epub_css(item.get_content().decode("utf-8", errors="replace"))
        for item in book.get_items_of_type(ITEM_STYLE)
    )
    return ParsedBook(title, _non_empty_chapters(chapters) or [Chapter(title, "")], css)


def chunk_chapter(text: str, min_len: int = 420, max_len: int = 620) -> list[Paragraph]:
    raw_parts = [
        Paragraph(text=part.strip(), text_hash=sha1_text(part.strip()))
        for part in re.split(r"\n\s*\n+", text)
        if part.strip()
    ]
    return chunk_paragraphs(raw_parts, min_len=min_len, max_len=max_len)


def chunk_paragraphs(raw_parts: list[Paragraph], min_len: int = 420, max_len: int = 620) -> list[Paragraph]:
    chunks: list[str] = []
    html_chunks: list[list[str | None]] = []
    audio_flags: list[bool] = []
    carry = ""
    carry_html: list[str | None] = []
    carry_audio = False

    for part in raw_parts:
        part_text = part.text.strip()
        if not part_text and not part.is_audio:
            if carry:
                chunks.append(carry)
                html_chunks.append(carry_html)
                audio_flags.append(carry_audio)
                carry = ""
                carry_html = []
                carry_audio = False
            chunks.append(part_text)
            html_chunks.append([part.html])
            audio_flags.append(False)
            continue

        if carry:
            candidate = f"{carry}\n{part_text}"
            if not carry_audio and part.is_audio and len(carry) < 120 and (len(carry_html) >= 3 or len(part_text) > 300):
                chunks.append(carry)
                html_chunks.append(carry_html)
                audio_flags.append(False)
                carry = ""
                carry_html = []
                carry_audio = False
            elif len(candidate) <= max_len:
                carry = candidate
                carry_html.append(part.html)
                carry_audio = carry_audio or part.is_audio
                continue
        if carry:
            candidate = f"{carry}\n{part_text}"
            if len(candidate) <= max_len:
                carry = candidate
                carry_html.append(part.html)
                carry_audio = carry_audio or part.is_audio
                continue
            _append_split_chunks(chunks, html_chunks, audio_flags, carry, carry_html, carry_audio, max_len)
            carry = ""
            carry_html = []
            carry_audio = False

        if len(part_text) < min_len:
            carry = part_text
            carry_html = [part.html]
            carry_audio = part.is_audio
        elif len(part_text) <= max_len:
            chunks.append(part_text)
            html_chunks.append([part.html])
            audio_flags.append(part.is_audio)
        else:
            _append_split_chunks(chunks, html_chunks, audio_flags, part_text, [part.html], part.is_audio, max_len)

    if carry:
        chunks.append(carry)
        html_chunks.append(carry_html)
        audio_flags.append(carry_audio)

    compacted: list[tuple[str, list[str | None], bool]] = []
    for chunk, htmls, is_audio in zip(chunks, html_chunks, audio_flags):
        if (
            is_audio
            and compacted
            and compacted[-1][2]
            and len(compacted[-1][0]) < min_len
            and len(compacted[-1][0]) + len(chunk) <= max_len
        ):
            prev_text, prev_htmls, _ = compacted[-1]
            compacted[-1] = (f"{prev_text}\n{chunk}", prev_htmls + htmls, True)
        else:
            compacted.append((chunk, htmls, is_audio))

    return [
        Paragraph(text=chunk, text_hash=sha1_text(chunk), html=_combine_html_fragments(htmls), is_audio=is_audio)
        for chunk, htmls, is_audio in compacted
        if chunk.strip() or htmls
    ]


def _append_split_chunks(
    chunks: list[str],
    html_chunks: list[list[str | None]],
    audio_flags: list[bool],
    text: str,
    htmls: list[str | None],
    is_audio: bool,
    max_len: int,
) -> None:
    parts = _split_paragraph(text, max_len)
    for part in parts:
        chunks.append(part)
        html_chunks.append(htmls if len(parts) == 1 else [None])
        audio_flags.append(is_audio)


def _combine_html_fragments(htmls: list[str | None]) -> str | None:
    clean = [html for html in htmls if html]
    if not clean:
        return None
    return '<div class="epub-fragment-page">' + "\n".join(clean) + "</div>"


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


def _chapters_from_toc(book, toc_nodes, spine_items: list, book_id: str | None, assets_dir: Path | None) -> list[Chapter]:
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
        raw_paragraphs: list[Paragraph] = []
        for item in spine_items[start:end]:
            raw_paragraphs.extend(_epub_item_paragraphs(book, item, book_id, assets_dir))
        paragraphs = chunk_paragraphs(raw_paragraphs) if raw_paragraphs else []
        if paragraphs or (text and not _looks_like_non_content(entry["title"], text)):
            chapter_text = text if not _looks_like_non_content(entry["title"], text) else "\n\n".join(
                paragraph.text for paragraph in paragraphs if paragraph.text
            )
            chapters.append(Chapter(entry["title"], chapter_text, paragraphs or None))
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


def _epub_item_paragraphs(book, item, book_id: str | None, assets_dir: Path | None) -> list[Paragraph]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(item.get_content(), "html.parser")
    _sanitize_epub_soup(soup, book, item.get_name(), book_id, assets_dir)
    body = soup.body or soup
    blocks = _content_blocks(body)
    paragraphs: list[Paragraph] = []
    for block in blocks:
        if block.name == "img":
            html = _fragment_for_block(soup, block, body)
            paragraphs.append(Paragraph(text="", text_hash=sha1_text(block.get("src", "")), html=html, is_audio=False))
            continue
        text = block.get_text(" ", strip=True)
        text = re.sub(r"\s+", " ", text).strip()
        if not text or _looks_like_non_content("", text):
            continue
        html = _fragment_for_block(soup, block, body)
        is_audio = len(_compact_text(text)) >= 30 and not _is_epub_front_matter_block(block)
        paragraphs.append(Paragraph(text=text, text_hash=sha1_text(text), html=html, is_audio=is_audio))
    if paragraphs:
        return paragraphs
    _, text = _epub_item_text(item)
    return [Paragraph(text=text, text_hash=sha1_text(text), html=None)] if text else []


def _content_blocks(root) -> list:
    blocks = _readable_blocks(root)
    content = []
    seen = set()
    for node in root.descendants:
        if not getattr(node, "name", None):
            continue
        if node in blocks and id(node) not in seen:
            content.append(node)
            seen.add(id(node))
        elif node.name == "img" and id(node) not in seen and _is_large_image_node(node):
            if not any(parent in blocks for parent in node.parents):
                content.append(node)
                seen.add(id(node))
    return content


def _is_epub_front_matter_block(block) -> bool:
    front_matter_classes = {"shuming", "chubanshe"}
    for node in [block, *list(block.parents)]:
        classes = set(node.get("class") or []) if getattr(node, "get", None) else set()
        if classes & front_matter_classes:
            return True
    return False


def _is_large_image_node(node) -> bool:
    width = _numeric_attr(node.get("width") or "")
    height = _numeric_attr(node.get("height") or "")
    style = str(node.get("style") or "")
    if not width:
        match = re.search(r"width\s*:\s*(\d+)", style)
        width = int(match.group(1)) if match else 0
    if not height:
        match = re.search(r"height\s*:\s*(\d+)", style)
        height = int(match.group(1)) if match else 0
    if width and height:
        return width >= 160 or height >= 120
    classes = " ".join(node.get("class") or []).lower()
    src = str(node.get("src") or "").lower()
    return any(keyword in f"{classes} {src}" for keyword in ("cover", "image", "figure", "jpg", "jpeg", "png"))


def _numeric_attr(value: str) -> int:
    match = re.search(r"\d+", str(value))
    return int(match.group(0)) if match else 0


def _readable_blocks(root) -> list:
    block_names = {"p", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"}
    structural_blocks = [
        tag
        for tag in root.find_all(["div", "section", "article", "aside", "blockquote"])
        if tag.get_text(" ", strip=True)
        and _is_epub_structural_block(tag)
        and not any(_is_epub_structural_block(parent) for parent in tag.parents if parent is not root)
    ]
    blocks = [
        tag
        for tag in root.find_all(block_names)
        if tag.get_text(" ", strip=True)
        and not any(parent in structural_blocks for parent in tag.parents)
    ]
    blocks = sorted([*structural_blocks, *blocks], key=lambda tag: len(list(tag.previous_elements)))
    if blocks:
        return blocks
    return [
        tag
        for tag in root.find_all(["div", "section", "article", "aside"])
        if tag.get_text(" ", strip=True)
        and not tag.find(["div", "section", "article", "aside", *block_names])
    ]


def _is_epub_structural_block(tag) -> bool:
    structural_classes = {
        "roundsolid",
        "solidtb",
        "solidorange",
        "juzhong",
        "juzhong1",
        "juzhong2",
        "juzhong3",
    }
    return bool(set(tag.get("class") or []) & structural_classes)


def _fragment_for_block(soup, block, body) -> str:
    from bs4 import BeautifulSoup

    wrapper = soup.new_tag("div")
    wrapper["class"] = ["epub-fragment"]
    chain = []
    parent = block.parent
    while parent and parent is not body and getattr(parent, "name", None) not in {"html", "body", "[document]"}:
        if parent.name in {"div", "section", "article", "aside", "blockquote", "table", "tbody", "tr"} or parent.get("class") or parent.get("style"):
            chain.append(parent)
        parent = parent.parent
    target = wrapper
    for original in reversed(chain[-3:]):
        clone = soup.new_tag(original.name)
        for key, value in original.attrs.items():
            clone.attrs[key] = value
        target.append(clone)
        target = clone
    target.append(block.decode_contents(formatter="html"))
    if block.name == "img":
        target.clear()
        block_clone = soup.new_tag("img")
        for key, value in block.attrs.items():
            block_clone.attrs[key] = value
        target.append(block_clone)
    elif block.name not in {"span", "strong", "em"}:
        target.clear()
        block_clone = soup.new_tag(block.name)
        for key, value in block.attrs.items():
            block_clone.attrs[key] = value
        block_clone.append(BeautifulSoup(block.decode_contents(formatter="html"), "html.parser"))
        target.append(block_clone)
    return str(wrapper)


def _sanitize_epub_soup(soup, book, item_name: str, book_id: str | None, assets_dir: Path | None) -> None:
    allowed_tags = {
        "a", "abbr", "aside", "b", "blockquote", "br", "caption", "cite", "code", "div", "em",
        "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li",
        "ol", "p", "pre", "section", "small", "span", "strong", "sub", "sup", "table", "tbody",
        "td", "tfoot", "th", "thead", "tr", "u", "ul",
    }
    allowed_attrs = {"class", "style", "title", "alt", "src", "href", "colspan", "rowspan"}
    for tag in soup(["script", "style", "nav", "iframe", "object", "embed", "link", "meta"]):
        tag.decompose()
    for tag in list(soup.find_all(True)):
        if tag.name not in allowed_tags:
            tag.unwrap()
            continue
        for attr in list(tag.attrs):
            if attr not in allowed_attrs or attr.lower().startswith("on"):
                del tag.attrs[attr]
        if tag.has_attr("style"):
            style = _sanitize_style_attr(str(tag["style"]))
            if style:
                tag["style"] = style
            else:
                del tag.attrs["style"]
        if tag.name == "a" and tag.has_attr("href"):
            href = str(tag["href"]).strip()
            if not href.startswith("#"):
                del tag.attrs["href"]
        if tag.name == "img" and tag.has_attr("src"):
            src = _asset_url_for_src(book, item_name, str(tag["src"]), book_id, assets_dir)
            if src:
                tag["src"] = src
            else:
                tag.decompose()


def _sanitize_style_attr(style: str) -> str:
    allowed = {
        "background", "background-color", "border", "border-bottom", "border-color", "border-left",
        "border-radius", "border-right", "border-style", "border-top", "border-width", "color",
        "display", "font-size", "font-style", "font-weight", "height", "line-height", "margin",
        "margin-bottom", "margin-left", "margin-right", "margin-top", "max-width", "padding",
        "padding-bottom", "padding-left", "padding-right", "padding-top", "text-align",
        "text-decoration", "text-indent", "vertical-align", "width",
    }
    declarations = []
    for part in style.split(";"):
        if ":" not in part:
            continue
        name, value = part.split(":", 1)
        name = name.strip().lower()
        value = value.strip()
        if name in allowed and not _has_remote_or_script_url(value):
            declarations.append(f"{name}: {value}")
    return "; ".join(declarations)


def _scope_epub_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    scoped = []
    for selector, body in re.findall(r"([^{}]+)\{([^{}]+)\}", css):
        selector = selector.strip()
        body = _sanitize_css_body(body)
        if not selector or not body or selector.startswith("@"):
            continue
        selectors = []
        for item in selector.split(","):
            clean = item.strip()
            if not clean or _has_remote_or_script_url(clean):
                continue
            clean = re.sub(r"\b(html|body)\b", ".epub-fragment", clean)
            if not clean.startswith(".paragraph-preview"):
                clean = f".paragraph-preview .epub-fragment {clean}"
            selectors.append(clean)
        if selectors:
            scoped.append(f"{', '.join(selectors)} {{{body}}}")
    return "\n".join(scoped)


def _sanitize_css_body(body: str) -> str:
    safe = _sanitize_style_attr(body)
    return f"{safe};" if safe else ""


def _has_remote_or_script_url(value: str) -> bool:
    lowered = value.lower()
    return "javascript:" in lowered or "url(http:" in lowered or "url(https:" in lowered or "@import" in lowered


def _asset_url_for_src(book, item_name: str, src: str, book_id: str | None, assets_dir: Path | None) -> str | None:
    if not book_id or not assets_dir:
        return None
    parsed = urlparse(src)
    if parsed.scheme or src.startswith("//"):
        return None
    clean_src = urldefrag(unquote(src))[0]
    href = posixpath.normpath(posixpath.join(posixpath.dirname(item_name), clean_src)).lstrip("/")
    item = book.get_item_with_href(href)
    if not item:
        item = book.get_item_with_href(clean_src)
    if not item:
        return None
    target = assets_dir / href
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(item.get_content())
    return f"/api/books/{book_id}/assets/{quote(href, safe='/')}"


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
