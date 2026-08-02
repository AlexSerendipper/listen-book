import { applyRemoteProgress, commitOfflineBook, getDevice, getRecord, saveDevice } from "./db.js?v=9";

const ASSET_CACHE = "listen-book-assets-v1";

async function parseError(response) {
  try {
    const payload = await response.json();
    return typeof payload.detail === "string" ? payload.detail : payload.detail?.message || "请求失败";
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export async function apiFetch(path, options = {}) {
  const device = await getDevice();
  if (!device?.credential) throw new Error("设备尚未配对");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${device.credential}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  if (!response.ok) throw new Error(await parseError(response));
  return response;
}

export async function fetchCatalog() {
  return (await apiFetch("/api/mobile/sync/manifest")).json();
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(buffer) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

export async function downloadBook(contentHash, onStatus = () => {}) {
  onStatus("正在读取资源清单…");
  const manifest = await (await apiFetch(`/api/mobile/books/${contentHash}/metadata`)).json();
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota || 0) - (estimate.usage || 0);
    if (estimate.quota && available < manifest.estimated_peak_bytes + 20 * 1024 * 1024) {
      throw new Error("预计存储空间不足，请先在系统设置中释放空间");
    }
  }
  const cache = await caches.open(ASSET_CACHE);
  let packageData = null;
  for (const [index, resource] of manifest.resources.entries()) {
    onStatus(`正在校验资源 ${index + 1} / ${manifest.resources.length}`);
    const response = await apiFetch(resource.url);
    const buffer = await response.arrayBuffer();
    if ((await sha256(buffer)) !== resource.sha256) {
      throw new Error(`资源校验失败：${resource.resource_id}`);
    }
    if (resource.resource_id === "package") {
      packageData = JSON.parse(new TextDecoder().decode(buffer));
    } else {
      const cacheKey = `/mobile/offline-assets/${contentHash}/${resource.resource_id}`;
      await cache.put(cacheKey, new Response(buffer, {
        headers: { "Content-Type": response.headers.get("Content-Type") || "application/octet-stream" },
      }));
    }
  }
  if (!packageData) throw new Error("解析包缺失");
  packageData.package_revision = manifest.package_revision;
  await commitOfflineBook(manifest, packageData);
  onStatus("已完整下载，可离线阅读");
  return manifest;
}

export async function refreshOfflineBook(book, onStatus = () => {}) {
  try {
    const manifest = await (await apiFetch(`/api/mobile/books/${book.content_hash}/metadata`)).json();
    if (manifest.package_revision === book.package_revision) return book;
    onStatus("发现新版解析包，正在更新…");
    await downloadBook(book.content_hash, onStatus);
    return (await getRecord("books", book.content_hash)) || book;
  } catch (error) {
    if (book.offline_status === "offline") return book;
    throw error;
  }
}

export async function pairDevice(shortCode, onStatus = () => {}) {
  let device = await getDevice();
  const deviceId = device?.device_id || crypto.randomUUID();
  const response = await fetch("/api/mobile/pair/request", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ short_code: shortCode, device_id: deviceId, device_name: "iPhone PWA" }),
  });
  if (!response.ok) throw new Error(await parseError(response));
  const pending = await response.json();
  onStatus("请求已送达，请回到电脑确认这部 iPhone");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const claim = await fetch(`/api/mobile/pair/${pending.session_id}/claim`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poll_secret: pending.poll_secret }),
    });
    if (claim.status === 403) continue;
    if (!claim.ok) throw new Error(await parseError(claim));
    const credentials = await claim.json();
    device = await saveDevice({
      device_id: credentials.device_id,
      device_name: "iPhone PWA",
      credential: credentials.credential,
      paired_at: new Date().toISOString(),
    });
    const ack = await fetch(`/api/mobile/pair/${pending.session_id}/ack`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poll_secret: pending.poll_secret }),
    });
    if (!ack.ok) throw new Error("凭证已保存，但电脑确认回执失败；请重新打开应用检查连接");
    return device;
  }
  throw new Error("等待电脑确认超时，请生成新短码重试");
}

export function connectForeground(device, onState) {
  let socket;
  let heartbeat;
  let closedByPage = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const open = () => {
    if (document.visibilityState !== "visible" || closedByPage) return;
    socket = new WebSocket(`${protocol}//${location.host}/api/mobile/control`);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "authenticate", device_id: device.device_id, credential: device.credential,
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "authenticated") {
        onState({ online: true, connectionEpoch: message.connection_epoch });
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
        }, 5000);
      }
    });
    socket.addEventListener("close", () => {
      clearInterval(heartbeat);
      onState({ online: false, connectionEpoch: null });
      if (!closedByPage && document.visibilityState === "visible") setTimeout(open, 1800);
    });
  };
  const visibility = () => {
    if (document.visibilityState === "hidden" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "suspended" }));
      socket.close();
    } else if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) {
      open();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  open();
  return () => {
    closedByPage = true;
    clearInterval(heartbeat);
    document.removeEventListener("visibilitychange", visibility);
    socket?.close();
  };
}

export async function pushProgress(contentHash, connectionEpoch) {
  const local = await getRecord("progress", contentHash);
  if (!local?.anchor) return { status: "source_progress_missing" };
  const preview = await (await apiFetch(`/api/mobile/books/${contentHash}/progress/preview`)).json();
  const operationId = crypto.randomUUID();
  return (await apiFetch(`/api/mobile/books/${contentHash}/progress/overwrite`, {
    method: "POST",
    body: JSON.stringify({
      direction: "mobile_to_desktop",
      operation_id: operationId,
      target_revision: preview.desktop.revision,
      connection_epoch: connectionEpoch,
      anchor: local.anchor,
    }),
  })).json();
}

export async function pullProgress(contentHash, connectionEpoch) {
  const local = await getRecord("progress", contentHash);
  const operationId = crypto.randomUUID();
  const result = await (await apiFetch(`/api/mobile/books/${contentHash}/progress/overwrite`, {
    method: "POST",
    body: JSON.stringify({
      direction: "desktop_to_mobile",
      operation_id: operationId,
      target_revision: local?.revision || 0,
      connection_epoch: connectionEpoch,
    }),
  })).json();
  if (result.status === "ready") {
    return applyRemoteProgress(result.source_anchor, local?.revision || 0, operationId);
  }
  return result;
}
