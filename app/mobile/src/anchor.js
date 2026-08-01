export function normalizeText(value) {
  return String(value).replace(/\r\n?/g, "\n").normalize("NFC");
}

export async function anchorTextHash(value, offset) {
  const points = Array.from(normalizeText(value));
  const start = Math.min(Math.max(offset - 32, 0), Math.max(points.length - 64, 0));
  const windowText = points.slice(start, Math.min(start + 64, points.length)).join("");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(windowText)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createTextAnchor(contentHash, chapterIndex, paragraph, offset = 0) {
  return {
    book_content_hash: contentHash,
    parser_version: "mobile-parser-v1",
    chapter_index: chapterIndex,
    paragraph_index: paragraph?.paragraph_index || 0,
    character_offset: offset,
    anchor_text_hash: await anchorTextHash(paragraph?.text || "", offset),
    anchor_asset_id: null,
    anchor_version: 1,
    client_updated_at: new Date().toISOString(),
  };
}
