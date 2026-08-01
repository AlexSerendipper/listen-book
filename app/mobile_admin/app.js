let csrfToken = "";
let sessionId = "";
let pollTimer;

const status = document.querySelector("#status");
const codeBox = document.querySelector("#codeBox");
const shortCode = document.querySelector("#shortCode");
const pending = document.querySelector("#pending");
const deviceName = document.querySelector("#deviceName");

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: `请求失败（${response.status}）` }));
    throw new Error(error.detail);
  }
  return response.json();
}

async function initializeSession() {
  const session = await request("/api/desktop/mobile/session", { method: "POST" });
  csrfToken = session.csrf_token;
  await renderDevices();
}

async function renderDevices() {
  const data = await request("/api/desktop/mobile/devices");
  const root = document.querySelector("#devices");
  root.replaceChildren();
  if (!data.devices.length) {
    root.textContent = "尚未登记手机。";
    return;
  }
  for (const device of data.devices) {
    const row = document.createElement("div");
    row.className = "device";
    const label = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.device_name;
    const detail = document.createElement("small");
    detail.textContent = device.revoked_at
      ? "已撤销"
      : `最近在线：${device.last_seen_at || "尚未连接"}`;
    label.append(name, detail);
    row.append(label);
    if (!device.revoked_at) {
      const revoke = document.createElement("button");
      revoke.textContent = "撤销";
      revoke.addEventListener("click", async () => {
        if (!confirm("撤销后手机仍可阅读离线书籍，但不能再同步。继续吗？")) return;
        await request(`/api/desktop/mobile/device/${device.device_id}`, { method: "DELETE" });
        await renderDevices();
      });
      row.append(revoke);
    }
    root.append(row);
  }
}

async function poll() {
  if (!sessionId) return;
  try {
    const data = await request(`/api/desktop/mobile/pair/${sessionId}`);
    if (data.status === "pending" && data.device_id) {
      pending.hidden = false;
      deviceName.textContent = data.device_name;
      status.textContent = "手机已提交请求，请核对并确认。";
    } else if (data.status === "completed") {
      clearInterval(pollTimer);
      pending.hidden = true;
      status.textContent = "配对完成。";
      await renderDevices();
    } else if (["expired", "rejected"].includes(data.status)) {
      clearInterval(pollTimer);
      status.textContent = "短码已失效，请重新生成。";
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

document.querySelector("#startPair").addEventListener("click", async () => {
  try {
    const data = await request("/api/desktop/mobile/pair/start", { method: "POST" });
    sessionId = data.session_id;
    shortCode.textContent = data.short_code.replace(/(.{5})/, "$1 ");
    codeBox.hidden = false;
    pending.hidden = true;
    status.textContent = "等待手机输入短码…";
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1200);
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#confirmPair").addEventListener("click", async () => {
  try {
    await request(`/api/desktop/mobile/pair/${sessionId}/confirm`, { method: "POST" });
    status.textContent = "已确认，等待手机保存凭证…";
  } catch (error) {
    status.textContent = error.message;
  }
});

initializeSession().catch((error) => { status.textContent = error.message; });
