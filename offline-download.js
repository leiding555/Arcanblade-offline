"use strict";

importScripts("offline-zip.js");

let controller;
self.onmessage = async ({ data }) => {
  if (data.cancel) {
    controller?.abort();
    return;
  }
  if (controller) return;
  const { path, file, size, blob, expectedCrc, previous } = data;
  controller = new AbortController();
  let access;
  let reported = 0;
  try {
    if (previous) {
      let identical = true;
      let crc = 0xffffffff;
      for (let offset = 0; offset < size && identical; offset += 256 * 1024) {
        controller.signal.throwIfAborted();
        const end = Math.min(offset + 256 * 1024, size);
        const [source, stored] = await Promise.all([blob, previous].map(async item =>
          new Uint8Array(await item.slice(offset, end).arrayBuffer())));
        identical = !source.some((byte, index) => byte !== stored[index]);
        crc = offlineZip.updateCrc(crc, source);
      }
      if (identical && ((crc ^ 0xffffffff) >>> 0) === expectedCrc) {
        self.postMessage({ unchanged: true });
        return;
      }
    }
    let mime = data.mime;
    let stream = blob?.stream();
    if (!blob) {
      const response = await fetch(path, { signal: controller.signal });
      if (response.status !== 200 || !response.body || Number(response.headers.get("Content-Length")) !== size) {
        throw new Error(response.status === 401 ? "配对已失效，请重新连接电脑。" : "音频已变化，请重试。");
      }
      mime = response.headers.get("Content-Type")?.split(";")[0];
      stream = response.body;
    }
    if (mime !== "audio/mpeg" && mime !== "audio/wav") throw new Error("音频格式不受支持。");

    const storage = await navigator.storage.getDirectory();
    const root = data.directory ? await storage.getDirectoryHandle(data.directory, { create: true }) : storage;
    const handle = await root.getFileHandle(file, { create: true });
    access = await handle.createSyncAccessHandle();
    const reader = stream.getReader();
    let written = 0;
    let crc = 0xffffffff;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.byteLength > size || access.write(value, { at: written }) !== value.byteLength) {
          throw new Error("音频未完整写入，请重试。");
        }
        written += value.byteLength;
        if (blob) crc = offlineZip.updateCrc(crc, value);
        const now = performance.now();
        if (now - reported >= 150 || written === size) {
          reported = now;
          self.postMessage({ written });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
    if (written !== size) throw new Error("音频未完整下载，请重试。");
    if (blob && ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new Error("离线包中的音频校验失败。");
    access.flush();
    access.close();
    access = null;
    self.postMessage({ mime });
  } catch (error) {
    access?.close();
    self.postMessage({ error: error.message, name: error.name });
  }
};
