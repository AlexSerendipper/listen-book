import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { anchorTextHash } from "../../app/mobile/src/anchor.js";

const vectors = JSON.parse(
  await readFile(new URL("./anchor-vectors.json", import.meta.url), "utf8"),
);

for (const vector of vectors) {
  assert.equal(await anchorTextHash(vector.text, vector.offset), vector.sha256);
}

console.log(`mobile anchor vectors: ${vectors.length} passed`);
