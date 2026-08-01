const DB_NAME = "listen-book-mobile";
const DB_VERSION = 1;

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const stores = [
        ["device", "key"],
        ["books", "content_hash"],
        ["packages", "book_content_hash"],
        ["progress", "book_content_hash"],
        ["progress_history", "book_content_hash"],
        ["operations", "operation_id"],
        ["settings", "key"],
      ];
      for (const [name, keyPath] of stores) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("数据库事务已取消"));
  });
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  return requestPromise(transaction.objectStore(storeName).get(key));
}

export async function putRecord(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  return value;
}

export async function allRecords(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  return requestPromise(transaction.objectStore(storeName).getAll());
}

export async function saveDevice(device) {
  return putRecord("device", { key: "current", ...device });
}

export async function getDevice() {
  return getRecord("device", "current");
}

export async function commitOfflineBook(manifest, packageData) {
  const db = await openDatabase();
  const transaction = db.transaction(["books", "packages"], "readwrite");
  const bookStore = transaction.objectStore("books");
  const current = await requestPromise(bookStore.get(manifest.book_content_hash));
  transaction.objectStore("packages").put(packageData);
  bookStore.put({
    content_hash: manifest.book_content_hash,
    title: manifest.metadata.title,
    author: manifest.metadata.author,
    format: manifest.metadata.format,
    parser_version: manifest.parser_version,
    anchor_version: manifest.anchor_version,
    package_revision: manifest.package_revision,
    offline_status: "offline",
    downloaded_at: new Date().toISOString(),
    last_read_at: current?.last_read_at || null,
  });
  await transactionDone(transaction);
}

export async function markBookRead(contentHash) {
  const db = await openDatabase();
  const transaction = db.transaction("books", "readwrite");
  const store = transaction.objectStore("books");
  const book = await requestPromise(store.get(contentHash));
  if (book) store.put({ ...book, last_read_at: new Date().toISOString() });
  await transactionDone(transaction);
}

export async function refreshOfflineMetadata(catalogBooks) {
  const remoteByHash = new Map(catalogBooks.map((book) => [book.content_hash, book]));
  const localBooks = await allRecords("books");
  await Promise.all(localBooks.map(async (book) => {
    const remote = remoteByHash.get(book.content_hash);
    if (!remote) return;
    await putRecord("books", {
      ...book,
      title: remote.title,
      author: remote.author || null,
      format: remote.format || book.format,
    });
  }));
}

function sameAnchor(left, right) {
  const fields = [
    "book_content_hash", "parser_version", "chapter_index", "paragraph_index",
    "character_offset", "anchor_text_hash", "anchor_asset_id", "anchor_version",
  ];
  return Boolean(left && right && fields.every((field) => left[field] === right[field]));
}

export async function saveLocalProgress(anchor, { dirty = true } = {}) {
  const db = await openDatabase();
  const transaction = db.transaction("progress", "readwrite");
  const store = transaction.objectStore("progress");
  const current = await requestPromise(store.get(anchor.book_content_hash));
  if (!sameAnchor(current?.anchor, anchor)) {
    store.put({
      book_content_hash: anchor.book_content_hash,
      anchor,
      revision: (current?.revision || 0) + 1,
      dirty,
      updated_at: new Date().toISOString(),
    });
  }
  await transactionDone(transaction);
}

export async function applyRemoteProgress(anchor, targetRevision, operationId) {
  const db = await openDatabase();
  const transaction = db.transaction(
    ["progress", "progress_history", "operations"], "readwrite",
  );
  const progressStore = transaction.objectStore("progress");
  const historyStore = transaction.objectStore("progress_history");
  const operationStore = transaction.objectStore("operations");
  const priorOperation = await requestPromise(operationStore.get(operationId));
  if (priorOperation) {
    await transactionDone(transaction);
    return priorOperation.result;
  }
  const current = await requestPromise(progressStore.get(anchor.book_content_hash));
  if ((current?.revision || 0) !== targetRevision) {
    transaction.abort();
    throw new Error("手机进度已变化，请重新预览后再覆盖");
  }
  historyStore.put({
    book_content_hash: anchor.book_content_hash,
    progress: current || null,
    consumed: false,
    created_at: new Date().toISOString(),
  });
  const result = { status: "overwritten", revision: targetRevision + 1, anchor };
  progressStore.put({
    book_content_hash: anchor.book_content_hash,
    anchor,
    revision: result.revision,
    dirty: false,
    updated_at: new Date().toISOString(),
  });
  operationStore.put({ operation_id: operationId, result, created_at: new Date().toISOString() });
  await transactionDone(transaction);
  return result;
}
