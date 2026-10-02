"use strict";

const DB_NAME = "einv-network-recorder";
const DB_VERSION = 4;
const objectUrls = new Map();
const encoder = new TextEncoder();

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("events")) { const store = db.createObjectStore("events", { keyPath: "id", autoIncrement: true }); store.createIndex("sessionId", "sessionId", { unique: false }); }
      if (!db.objectStoreNames.contains("bodies")) { const store = db.createObjectStore("bodies", { keyPath: "key" }); store.createIndex("sessionId", "sessionId", { unique: false }); }
      if (!db.objectStoreNames.contains("downloads")) { const store = db.createObjectStore("downloads", { keyPath: "key" }); store.createIndex("sessionId", "sessionId", { unique: false }); store.createIndex("chromeDownloadId", "chromeDownloadId", { unique: false }); }
      if (!db.objectStoreNames.contains("downloadChunks")) { const store = db.createObjectStore("downloadChunks", { keyPath: "id", autoIncrement: true }); store.createIndex("sessionId", "sessionId", { unique: false }); store.createIndex("requestKey", "requestKey", { unique: false }); }
      if (!db.objectStoreNames.contains("artifacts")) { const store = db.createObjectStore("artifacts", { keyPath: "key" }); store.createIndex("sessionId", "sessionId", { unique: false }); store.createIndex("name", "name", { unique: false }); }
      if (!db.objectStoreNames.contains("warnings")) { const store = db.createObjectStore("warnings", { keyPath: "id", autoIncrement: true }); store.createIndex("sessionId", "sessionId", { unique: false }); }
      if (!db.objectStoreNames.contains("pageBlobs")) { const store = db.createObjectStore("pageBlobs", { keyPath: "key" }); store.createIndex("sessionId", "sessionId", { unique: false }); store.createIndex("objectUrl", "objectUrl", { unique: false }); }
      if (!db.objectStoreNames.contains("pageBlobChunks")) { const store = db.createObjectStore("pageBlobChunks", { keyPath: "id", autoIncrement: true }); store.createIndex("sessionId", "sessionId", { unique: false }); store.createIndex("blobKey", "blobKey", { unique: false }); }
      if (!db.objectStoreNames.contains("traceChunks")) { const store = db.createObjectStore("traceChunks", { keyPath: "id", autoIncrement: true }); store.createIndex("sessionId", "sessionId", { unique: false }); }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function dbGet(storeName, key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`IndexedDB get failed: ${storeName}`));
    });
  } finally {
    db.close();
  }
}

async function dbGetAllBySession(storeName, sessionId) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const index = store.index("sessionId");
      const request = index.getAll(IDBKeyRange.only(sessionId));
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`IndexedDB index read failed: ${storeName}`));
    });
  } finally {
    db.close();
  }
}


function jsonBytes(value) {
  return encoder.encode(JSON.stringify(value, null, 2));
}

function base64ToBytes(text) {
  const binary = atob(text || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(state, bytes) {
  let c = state;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function crc32Parts(parts) {
  let state = 0xffffffff;
  for (const part of parts) state = crc32Update(state, part);
  return (state ^ 0xffffffff) >>> 0;
}


class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
    this.temp = new Uint32Array(64);
  }

  update(data) {
    if (this.finished) throw new Error("SHA-256 already finalized");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let pos = 0;
    this.bytesHashed += bytes.length;
    while (pos < bytes.length) {
      const take = Math.min(bytes.length - pos, 64 - this.bufferLength);
      this.buffer.set(bytes.subarray(pos, pos + take), this.bufferLength);
      this.bufferLength += take;
      pos += take;
      if (this.bufferLength === 64) {
        this._process(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  _process(chunk) {
    const w = this.temp;
    for (let i = 0; i < 16; i += 1) {
      const j = i * 4;
      w[i] = ((chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) >>> 0;
      const s1 = (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.h;
    const k = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    for (let i = 0; i < 64; i += 1) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + k[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  digestHex() {
    if (!this.finished) {
      const bitLength = this.bytesHashed * 8;
      this.buffer[this.bufferLength++] = 0x80;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength, 64);
        this._process(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, high >>> 0, false);
      view.setUint32(60, low, false);
      this._process(this.buffer);
      this.finished = true;
    }
    return Array.from(this.h).map((value) => value.toString(16).padStart(8, "0")).join("");
  }
}

function sha256Parts(parts) {
  const sha = new Sha256();
  for (const part of parts) sha.update(part);
  return sha.digestHex();
}

function dosDateTime(date) {
  const d = date || new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const day = ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

function write16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function zipCategory(name) {
  const parts = String(name || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return "root";
  if (parts[0] === "bodies" && parts[1]) return "bodies/" + parts[1];
  return parts[0];
}

function shouldDeflateZipEntry(name, size) {
  if (size < 256) return false;
  const lower = String(name || "").toLowerCase();
  return !/\.(png|jpe?g|gif|webp|avif|woff2?|zip|gz|br|7z|rar|mp4|webm|mp3|ogg|wasm|pdf)$/i.test(lower);
}

async function deflateRawParts(parts) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const source = new Blob(parts).stream();
    const compressed = source.pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  } catch (_) {
    return null;
  }
}

class ZipBuilder {
  constructor() { this.entries = []; }

  addFile(name, data) {
    const bytes = data instanceof Uint8Array ? data : encoder.encode(String(data));
    this.entries.push({ name: String(name).replace(/\\/g, "/"), parts: [bytes], size: bytes.length, crc: crc32(bytes), prepared: null });
  }

  addFileParts(name, parts) {
    const byteParts = parts.map((part) => part instanceof Uint8Array ? part : encoder.encode(String(part)));
    this.entries.push({
      name: String(name).replace(/\\/g, "/"),
      parts: byteParts,
      size: byteParts.reduce((sum, part) => sum + part.length, 0),
      crc: crc32Parts(byteParts),
      prepared: null
    });
  }

  async _prepareEntry(entry) {
    if (entry.prepared) return;
    let method = 0;
    let payloadParts = entry.parts;
    let payloadSize = entry.size;
    if (shouldDeflateZipEntry(entry.name, entry.size)) {
      const compressed = await deflateRawParts(entry.parts);
      if (compressed && compressed.length < entry.size) { method = 8; payloadParts = [compressed]; payloadSize = compressed.length; }
    }
    entry.prepared = { method, payloadParts, payloadSize };
  }

  async preparePending() { for (const entry of this.entries) await this._prepareEntry(entry); }

  getStats() {
    const stats = { entries: this.entries.length, uncompressedBytes: 0, archiveDataBytes: 0, savedBytes: 0, methods: { store: 0, deflate: 0 }, categories: {} };
    for (const entry of this.entries) {
      const prepared = entry.prepared || { method: 0, payloadSize: entry.size };
      const category = zipCategory(entry.name);
      if (!stats.categories[category]) stats.categories[category] = { entries: 0, uncompressedBytes: 0, archiveDataBytes: 0, savedBytes: 0 };
      const bucket = stats.categories[category];
      stats.uncompressedBytes += entry.size;
      stats.archiveDataBytes += prepared.payloadSize;
      stats.savedBytes += Math.max(0, entry.size - prepared.payloadSize);
      stats.methods[prepared.method === 8 ? "deflate" : "store"] += 1;
      bucket.entries += 1;
      bucket.uncompressedBytes += entry.size;
      bucket.archiveDataBytes += prepared.payloadSize;
      bucket.savedBytes += Math.max(0, entry.size - prepared.payloadSize);
    }
    stats.compressionRatio = stats.uncompressedBytes > 0 ? stats.archiveDataBytes / stats.uncompressedBytes : 1;
    return stats;
  }

  async buildBlob() {
    await this.preparePending();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let count = 0;
    for (const entry of this.entries) {
      const filename = encoder.encode(entry.name);
      const prepared = entry.prepared;
      const stamp = dosDateTime(new Date());
      const local = new Uint8Array(30 + filename.length);
      const lv = new DataView(local.buffer);
      write32(lv, 0, 0x04034b50); write16(lv, 4, 20); write16(lv, 6, 0x0800); write16(lv, 8, prepared.method);
      write16(lv, 10, stamp.time); write16(lv, 12, stamp.day); write32(lv, 14, entry.crc);
      write32(lv, 18, prepared.payloadSize); write32(lv, 22, entry.size); write16(lv, 26, filename.length); write16(lv, 28, 0); local.set(filename, 30);
      const central = new Uint8Array(46 + filename.length);
      const cv = new DataView(central.buffer);
      write32(cv, 0, 0x02014b50); write16(cv, 4, 20); write16(cv, 6, 20); write16(cv, 8, 0x0800); write16(cv, 10, prepared.method);
      write16(cv, 12, stamp.time); write16(cv, 14, stamp.day); write32(cv, 16, entry.crc);
      write32(cv, 20, prepared.payloadSize); write32(cv, 24, entry.size); write16(cv, 28, filename.length);
      write16(cv, 30, 0); write16(cv, 32, 0); write16(cv, 34, 0); write16(cv, 36, 0); write32(cv, 38, 0); write32(cv, 42, offset); central.set(filename, 46);
      localParts.push(local, ...prepared.payloadParts); centralParts.push(central); offset += local.length + prepared.payloadSize; count += 1;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22); const ev = new DataView(end.buffer);
    write32(ev, 0, 0x06054b50); write16(ev, 4, 0); write16(ev, 6, 0); write16(ev, 8, count); write16(ev, 10, count); write32(ev, 12, centralSize); write32(ev, 16, offset); write16(ev, 20, 0);
    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  }
}

function eventSourceKey(event) {
  return event?.source?.sessionId || "root";
}

function requestBaseKey(event) {
  return `${eventSourceKey(event)}|${event?.params?.requestId || ""}`;
}

function headersToHar(headers) {
  if (!headers || typeof headers !== "object") {
    return [];
  }
  return Object.entries(headers).flatMap(([name, value]) => String(value).split("\n").map((item) => ({ name, value: item })));
}

function queryToHar(url) {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch (_) {
    return [];
  }
}

function textBodyExtension(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("json")) return "json";
  if (mime.includes("javascript")) return "js";
  if (mime.includes("text/css")) return "css";
  if (mime.includes("text/html")) return "html";
  if (mime.includes("xml")) return "xml";
  if (mime.startsWith("text/")) return "txt";
  return "txt";
}

function binaryBodyExtension(mimeType, url) {
  const mime = String(mimeType || "").toLowerCase();
  const byMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "font/woff": "woff",
    "font/woff2": "woff2",
    "application/wasm": "wasm",
    "application/zip": "zip"
  };
  if (byMime[mime]) return byMime[mime];
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]{1,8})$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) { }
  return "bin";
}

function buildDerived(events, bodyRecords) {
  const requests = [];
  const current = new Map();
  const pendingRequestExtra = new Map();
  const pendingResponseExtra = new Map();
  const bodyMap = new Map(bodyRecords.map((item) => [`${item.sourceSessionId || "root"}|${item.requestId}|${item.kind}`, item]));

  const ensureCurrent = (event) => {
    const base = requestBaseKey(event);
    return current.get(base) || null;
  };

  for (const event of events) {
    const method = event.method;
    const params = event.params || {};
    const base = requestBaseKey(event);

    if (method === "Network.requestWillBeSent") {
      const previous = current.get(base);
      if (previous && params.redirectResponse) {
        previous.response = params.redirectResponse;
        previous.redirect = true;
      }

      const item = {
        key: `${base}|${requests.length}`,
        sourceSessionId: eventSourceKey(event),
        requestId: params.requestId,
        sequence: requests.length + 1,
        request: params.request || {},
        documentURL: params.documentURL || null,
        type: params.type || null,
        initiator: params.initiator || null,
        frameId: params.frameId || null,
        loaderId: params.loaderId || null,
        timestamp: params.timestamp ?? null,
        wallTime: params.wallTime ?? null,
        requestExtraInfo: null,
        response: null,
        responseExtraInfo: null,
        loadingFinished: null,
        loadingFailed: null,
        servedFromCache: false,
        redirect: false,
        requestBodyFile: null,
        responseBodyFile: null
      };
      if (pendingRequestExtra.has(base)) {
        item.requestExtraInfo = pendingRequestExtra.get(base).shift() || null;
        if (!pendingRequestExtra.get(base).length) pendingRequestExtra.delete(base);
      }
      if (pendingResponseExtra.has(base)) {
        item.responseExtraInfo = pendingResponseExtra.get(base).shift() || null;
        if (!pendingResponseExtra.get(base).length) pendingResponseExtra.delete(base);
      }
      requests.push(item);
      current.set(base, item);
      continue;
    }

    if (method === "Network.requestWillBeSentExtraInfo") {
      const item = ensureCurrent(event);
      if (item && !item.requestExtraInfo) {
        item.requestExtraInfo = params;
      } else {
        const list = pendingRequestExtra.get(base) || [];
        list.push(params);
        pendingRequestExtra.set(base, list);
      }
      continue;
    }

    if (method === "Network.responseReceived") {
      const item = ensureCurrent(event);
      if (item) item.response = params.response || null;
      continue;
    }

    if (method === "Network.responseReceivedExtraInfo") {
      const item = ensureCurrent(event);
      if (item && !item.responseExtraInfo) {
        item.responseExtraInfo = params;
      } else {
        const list = pendingResponseExtra.get(base) || [];
        list.push(params);
        pendingResponseExtra.set(base, list);
      }
      continue;
    }

    if (method === "Network.loadingFinished") {
      const item = ensureCurrent(event);
      if (item) item.loadingFinished = params;
      continue;
    }

    if (method === "Network.loadingFailed") {
      const item = ensureCurrent(event);
      if (item) item.loadingFailed = params;
      continue;
    }

    if (method === "Network.requestServedFromCache") {
      const item = ensureCurrent(event);
      if (item) item.servedFromCache = true;
    }
  }

  for (const item of requests) {
    const requestBody = bodyMap.get(`${item.sourceSessionId}|${item.requestId}|request`);
    const responseBody = bodyMap.get(`${item.sourceSessionId}|${item.requestId}|response`);
    if (requestBody) item._requestBody = requestBody;
    if (responseBody) item._responseBody = responseBody;
  }

  return requests;
}

function makeHar(session, requests) {
  const entries = requests.map((item) => {
    const request = item.request || {};
    const response = item.response || {};
    const requestHeaders = item.requestExtraInfo?.headers || request.headers || {};
    const responseHeaders = item.responseExtraInfo?.headers || response.headers || {};
    const startMs = item.wallTime ? item.wallTime * 1000 : Date.parse(session.startTime);
    const totalMs = item.loadingFinished?.timestamp != null && item.timestamp != null
      ? Math.max(0, (item.loadingFinished.timestamp - item.timestamp) * 1000)
      : 0;
    const requestBodyText = item._requestBody && !item._requestBody.base64Encoded
      ? item._requestBody.body
      : request.postData;

    const content = {
      size: Number(item.loadingFinished?.encodedDataLength || response.encodedDataLength || 0),
      mimeType: response.mimeType || "application/octet-stream"
    };
    if (item.responseBodyFile) content._bodyFile = item.responseBodyFile;

    const harRequest = {
      method: request.method || "GET",
      url: request.url || "",
      httpVersion: "HTTP/1.1",
      headers: headersToHar(requestHeaders),
      queryString: queryToHar(request.url || ""),
      cookies: [],
      headersSize: -1,
      bodySize: typeof requestBodyText === "string" ? encoder.encode(requestBodyText).length : -1
    };
    if (typeof requestBodyText === "string") {
      harRequest.postData = {
        mimeType: String(requestHeaders["content-type"] || requestHeaders["Content-Type"] || "application/octet-stream"),
        text: requestBodyText
      };
    }
    if (item.requestBodyFile) harRequest._bodyFile = item.requestBodyFile;

    return {
      startedDateTime: new Date(Number.isFinite(startMs) ? startMs : Date.now()).toISOString(),
      time: totalMs,
      request: harRequest,
      response: {
        status: Number(response.status || 0),
        statusText: response.statusText || "",
        httpVersion: response.protocol || "HTTP/1.1",
        headers: headersToHar(responseHeaders),
        cookies: [],
        content,
        redirectURL: String(responseHeaders.location || responseHeaders.Location || ""),
        headersSize: -1,
        bodySize: Number(item.loadingFinished?.encodedDataLength || -1)
      },
      cache: item.servedFromCache ? { _servedFromCache: true } : {},
      timings: { send: 0, wait: totalMs, receive: 0 },
      _resourceType: item.type,
      _requestId: item.requestId,
      _sourceSessionId: item.sourceSessionId,
      _loadingFailed: item.loadingFailed || undefined,
      _initiator: item.initiator || undefined
    };
  });

  return {
    log: {
      version: "1.2",
      creator: { name: "Network Recorder", version: session.extensionVersion || "1.0.0" },
      pages: [],
      entries
    }
  };
}

function filenameStamp(iso) {
  const d = new Date(iso || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFilename(name) {
  const cleaned = String(name || "download.bin")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "download.bin";
}

function basenameFromPath(value) {
  const text = String(value || "").replace(/\\/g, "/");
  return text.split("/").filter(Boolean).pop() || "";
}

function downloadFilename(record) {
  if (record?.suggestedFilename) return safeFilename(record.suggestedFilename);
  if (record?.localFilename) return safeFilename(basenameFromPath(record.localFilename));
  try {
    const name = basenameFromPath(new URL(record?.finalUrl || record?.url || "").pathname);
    if (name) return safeFilename(decodeURIComponent(name));
  } catch (_) { }
  return "download.bin";
}


function artifactBytes(artifact) {
  if (artifact.encoding === "base64") return base64ToBytes(artifact.value || "");
  if (artifact.encoding === "text") return encoder.encode(String(artifact.value || ""));
  return jsonBytes(artifact.value);
}

function cookieIdentity(cookie) {
  return `${cookie.name || ""}|${cookie.domain || ""}|${cookie.path || ""}|${cookie.partitionKey?.topLevelSite || ""}`;
}

function diffCookies(before, after) {
  const a = new Map((before || []).map((cookie) => [cookieIdentity(cookie), cookie]));
  const b = new Map((after || []).map((cookie) => [cookieIdentity(cookie), cookie]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, value] of b) {
    if (!a.has(key)) added.push(value);
    else if (JSON.stringify(a.get(key)) !== JSON.stringify(value)) changed.push({ before: a.get(key), after: value });
  }
  for (const [key, value] of a) if (!b.has(key)) removed.push(value);
  return { added, removed, changed };
}

function diffObjectValues(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const added = {};
  const removed = {};
  const changed = {};
  for (const key of keys) {
    if (!(key in (before || {}))) added[key] = after[key];
    else if (!(key in (after || {}))) removed[key] = before[key];
    else if (before[key] !== after[key]) changed[key] = { before: before[key], after: after[key] };
  }
  return { added, removed, changed };
}

function filenameFromUrl(url, fallback) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return safeFilename(name || fallback);
  } catch (_) {
    return safeFilename(fallback);
  }
}

async function exportSession(sessionId, tabId) {
  const session = await dbGet("sessions", sessionId);
  if (!session) throw new Error("Сессия записи не найдена.");

  const [events, bodies, downloads, downloadChunks, artifacts, warnings, pageBlobs, pageBlobChunks, traceChunks] = await Promise.all([
    dbGetAllBySession("events", sessionId),
    dbGetAllBySession("bodies", sessionId),
    dbGetAllBySession("downloads", sessionId),
    dbGetAllBySession("downloadChunks", sessionId),
    dbGetAllBySession("artifacts", sessionId),
    dbGetAllBySession("warnings", sessionId),
    dbGetAllBySession("pageBlobs", sessionId),
    dbGetAllBySession("pageBlobChunks", sessionId),
    dbGetAllBySession("traceChunks", sessionId)
  ]);
  events.sort((a, b) => (a.id || 0) - (b.id || 0));
  warnings.sort((a, b) => (a.id || 0) - (b.id || 0));
  downloadChunks.sort((a, b) => (a.id || 0) - (b.id || 0));
  pageBlobChunks.sort((a, b) => (a.id || 0) - (b.id || 0));
  traceChunks.sort((a, b) => (a.index ?? a.id ?? 0) - (b.index ?? b.id ?? 0));

  const requests = buildDerived(events, bodies);
  const zip = new ZipBuilder();
  const artifactMap = new Map(artifacts.map((item) => [item.name, item]));
  const scriptManifest = [];
  const resourceManifest = [];

  const traceParts = traceChunks.map((item) => {
    const value = item?.bytes;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array();
  }).filter((part) => part.byteLength > 0);
  const traceBytes = traceParts.reduce((sum, part) => sum + part.byteLength, 0);
  if (traceParts.length > 0) {
    zip.addFileParts("tracing/chromium-trace.json", traceParts);
  }

  for (const artifact of artifacts) {
    try {
      zip.addFile(artifact.name, artifactBytes(artifact));
    } catch (error) {
      warnings.push({
        sessionId,
        capturedAt: new Date().toISOString(),
        code: "artifact-export-failed",
        message: `Не удалось добавить артефакт ${artifact.name} в ZIP.`,
        detail: error?.message || String(error)
      });
    }
  }

  for (const item of requests) {
    const baseIndex = String(item.sequence).padStart(5, "0");
    const requestBody = item._requestBody;
    const responseBody = item._responseBody;

    if (requestBody) {
      const ext = requestBody.base64Encoded ? "bin" : "txt";
      const path = `bodies/request/${baseIndex}.${ext}`;
      const bytes = requestBody.base64Encoded ? base64ToBytes(requestBody.body) : encoder.encode(requestBody.body || "");
      zip.addFile(path, bytes);
      item.requestBodyFile = path;
      item.requestBodySha256 = sha256Parts([bytes]);
    }

    let responseBytes = null;
    if (responseBody) {
      const mime = item.response?.mimeType || "";
      const ext = responseBody.base64Encoded ? binaryBodyExtension(mime, item.request?.url || "") : textBodyExtension(mime);
      const path = `bodies/response/${baseIndex}.${ext}`;
      responseBytes = responseBody.base64Encoded ? base64ToBytes(responseBody.body) : encoder.encode(responseBody.body || "");
      zip.addFile(path, responseBytes);
      item.responseBodyFile = path;
      item.responseBodySha256 = sha256Parts([responseBytes]);

      const type = String(item.type || "").toLowerCase();
      const isScript = type === "script" || /javascript|ecmascript/i.test(mime);
      if (isScript) {
        const scriptName = filenameFromUrl(item.request?.url || "", `${baseIndex}.js`);
        const scriptPath = `scripts/files/${baseIndex}-${scriptName.endsWith(".js") ? scriptName : `${scriptName}.js`}`;
        zip.addFile(scriptPath, responseBytes);
        scriptManifest.push({
          sequence: item.sequence,
          url: item.request?.url || "",
          mimeType: mime,
          file: scriptPath,
          bodyFile: path,
          sha256: item.responseBodySha256
        });
      }
    }

    resourceManifest.push({
      sequence: item.sequence,
      requestId: item.requestId,
      url: item.request?.url || "",
      method: item.request?.method || "GET",
      type: item.type || null,
      status: item.response?.status ?? null,
      mimeType: item.response?.mimeType || null,
      servedFromCache: Boolean(item.servedFromCache),
      encodedDataLength: item.loadingFinished?.encodedDataLength ?? item.response?.encodedDataLength ?? null,
      requestBodyFile: item.requestBodyFile || null,
      responseBodyFile: item.responseBodyFile || null,
      responseBodySha256: item.responseBodySha256 || null,
      bodyCaptured: Boolean(item.responseBodyFile),
      loadingFailed: item.loadingFailed || null
    });

  }

  const endHtml = artifactMap.get("page/page.html")?.value;
  if (typeof endHtml === "string" && endHtml) {
    try {
      const doc = new DOMParser().parseFromString(endHtml, "text/html");
      const inlineScripts = Array.from(doc.querySelectorAll("script:not([src])"));
      for (let i = 0; i < inlineScripts.length; i += 1) {
        const source = inlineScripts[i].textContent || "";
        if (!source.trim()) continue;
        const path = `scripts/inline/${String(i + 1).padStart(3, "0")}.js`;
        const bytes = encoder.encode(source);
        zip.addFile(path, bytes);
        scriptManifest.push({ inline: true, index: i + 1, file: path, sha256: sha256Parts([bytes]), chars: source.length });
      }
    } catch (_) { }
  }
  zip.addFile("resources/manifest.json", jsonBytes(resourceManifest));
  zip.addFile("scripts/manifest.json", jsonBytes(scriptManifest));

  const chunksByRequest = new Map();
  for (const chunk of downloadChunks) {
    const list = chunksByRequest.get(chunk.requestKey) || [];
    list.push(chunk);
    chunksByRequest.set(chunk.requestKey, list);
  }

  const bodyByRequest = new Map();
  for (const body of bodies) {
    if (body.kind === "response") {
      bodyByRequest.set(`${sessionId}|${body.sourceSessionId || "root"}|${body.requestId}`, body);
    }
  }

  const downloadManifest = [];
  const usedNames = new Set();
  let capturedDownloadFiles = 0;
  let metadataOnlyDownloads = 0;

  downloads.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  for (let i = 0; i < downloads.length; i += 1) {
    const record = { ...downloads[i] };
    const chunks = chunksByRequest.get(record.key) || [];
    let parts = chunks.map((chunk) => base64ToBytes(chunk.data || ""));
    let captureSource = parts.length ? "Network.streamResourceContent" : null;

    if (!parts.length && record.requestId) {
      const fallbackBody = bodyByRequest.get(`${sessionId}|${record.sourceSessionId || "root"}|${record.requestId}`);
      if (fallbackBody) {
        parts = [fallbackBody.base64Encoded ? base64ToBytes(fallbackBody.body || "") : encoder.encode(fallbackBody.body || "")];
        captureSource = "Network.getResponseBody";
      }
    }

    let archiveFile = null;
    let capturedBytes = 0;
    let sha256 = null;
    if (parts.length) {
      let base = downloadFilename(record);
      let candidate = base;
      let suffix = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        const dot = base.lastIndexOf(".");
        candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
        suffix += 1;
      }
      usedNames.add(candidate.toLowerCase());
      archiveFile = `downloads/files/${String(i + 1).padStart(3, "0")}-${candidate}`;
      zip.addFileParts(archiveFile, parts);
      capturedBytes = parts.reduce((sum, part) => sum + part.length, 0);
      sha256 = sha256Parts(parts);
      capturedDownloadFiles += 1;
    } else {
      metadataOnlyDownloads += 1;
    }

    record.archiveFile = archiveFile;
    record.capturedBytes = capturedBytes;
    record.sha256 = sha256;
    record.captureSource = captureSource;
    record.bytesCaptured = Boolean(archiveFile);
    record.captureStatus = archiveFile ? "complete" : (record.status === "failed" ? "failed" : "metadata-only");
    downloadManifest.push(record);
  }

  zip.addFile("downloads/manifest.json", jsonBytes(downloadManifest));

  const blobChunksByKey = new Map();
  for (const chunk of pageBlobChunks) {
    const list = blobChunksByKey.get(chunk.blobKey) || [];
    list.push(chunk);
    blobChunksByKey.set(chunk.blobKey, list);
  }
  const blobManifest = [];
  let capturedPageBlobs = 0;
  const blobNames = new Set();
  pageBlobs.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  for (let i = 0; i < pageBlobs.length; i += 1) {
    const record = { ...pageBlobs[i] };
    const chunks = (blobChunksByKey.get(record.key) || []).sort((a, b) => (a.index || 0) - (b.index || 0));
    const parts = chunks.map((chunk) => base64ToBytes(chunk.data || ""));
    let archiveFile = null;
    if (parts.length && record.status === "complete") {
      let base = safeFilename(record.suggestedFilename || `blob-${String(i + 1).padStart(3, "0")}.${binaryBodyExtension(record.mimeType || "", "")}`);
      let candidate = base;
      let suffix = 2;
      while (blobNames.has(candidate.toLowerCase())) {
        const dot = base.lastIndexOf(".");
        candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
        suffix += 1;
      }
      blobNames.add(candidate.toLowerCase());
      archiveFile = `blobs/files/${candidate}`;
      zip.addFileParts(archiveFile, parts);
      record.sha256 = sha256Parts(parts);
      record.archiveFile = archiveFile;
      record.capturedBytes = parts.reduce((sum, part) => sum + part.length, 0);
      capturedPageBlobs += 1;
    } else {
      record.archiveFile = null;
      record.sha256 = null;
    }
    blobManifest.push(record);
  }
  zip.addFile("blobs/manifest.json", jsonBytes(blobManifest));

  const realtime = events.filter((event) => /^(Network\.(webSocket|eventSource|webTransport)|Recorder\.debuggerDetached)/.test(event.method));
  const actions = events.filter((event) => event.method === "Recorder.userAction");
  const consoleEvents = events.filter((event) => event.method === "Runtime.consoleAPICalled" || event.method === "Log.entryAdded");
  const jsErrors = events.filter((event) => event.method === "Runtime.exceptionThrown" || event.method === "Runtime.exceptionRevoked");
  const navigation = events.filter((event) => /^Page\.(frameNavigated|navigatedWithinDocument|frameStartedLoading|frameStoppedLoading|lifecycleEvent)$/.test(event.method) || event.method === "Recorder.userAction" && /^(hashchange|popstate)$/.test(event.params?.kind || ""));
  const domMutations = events.filter((event) => event.method === "Recorder.domMutation");
  const targets = events.filter((event) => /^Target\.|^Recorder\.targetAttached$/.test(event.method));
  const apiSummary = requests.filter((item) => /^(XHR|Fetch)$/i.test(String(item.type || ""))).map((item) => ({
    sequence: item.sequence,
    method: item.request?.method || "GET",
    url: item.request?.url || "",
    status: item.response?.status ?? null,
    mimeType: item.response?.mimeType || null,
    requestBodyFile: item.requestBodyFile || null,
    responseBodyFile: item.responseBodyFile || null,
    loadingFailed: item.loadingFailed || null
  }));
  const bodyWarnings = events.filter((event) => event.method === "Recorder.responseBodyUnavailable");
  const cookieHttpEvidence = [];
  for (const event of events) {
    const headers = event.params?.headers;
    if (!headers || typeof headers !== "object") continue;
    const selected = {};
    for (const [name, value] of Object.entries(headers)) {
      if (/^(cookie|set-cookie)$/i.test(name)) selected[name] = value;
    }
    if (Object.keys(selected).length) {
      cookieHttpEvidence.push({ capturedAt: event.capturedAt, method: event.method, source: event.source, requestId: event.params?.requestId || null, headers: selected });
    }
  }

  zip.addFile("actions.json", jsonBytes(actions));
  zip.addFile("console.json", jsonBytes(consoleEvents));
  zip.addFile("javascript-errors.json", jsonBytes(jsErrors));
  zip.addFile("navigation.json", jsonBytes(navigation));
  zip.addFile("dom-mutations.json", jsonBytes(domMutations));
  zip.addFile("browser/targets.json", jsonBytes(targets));
  zip.addFile("api-summary.json", jsonBytes(apiSummary));
  zip.addFile("realtime.json", jsonBytes(realtime));
  zip.addFile("capture-warnings.json", jsonBytes(warnings));
  zip.addFile("browser/cookie-http-evidence.json", jsonBytes(cookieHttpEvidence));

  const cookieStart = artifactMap.get("browser/start/cookies.json")?.value || [];
  const cookieEnd = artifactMap.get("browser/end/cookies.json")?.value || [];
  zip.addFile("browser/cookie-changes.json", jsonBytes(diffCookies(cookieStart, cookieEnd)));

  const pageStart = artifactMap.get("browser/start/page-snapshot.json")?.value || {};
  const pageEnd = artifactMap.get("browser/end/page-snapshot.json")?.value || {};
  zip.addFile("browser/storage-changes.json", jsonBytes({
    localStorage: diffObjectValues(pageStart.localStorage || {}, pageEnd.localStorage || {}),
    sessionStorage: diffObjectValues(pageStart.sessionStorage || {}, pageEnd.sessionStorage || {})
  }));
  zip.addFile("performance.json", jsonBytes({
    start: pageStart.performance || null,
    end: pageEnd.performance || null,
    startMetrics: artifactMap.get("browser/start/performance-metrics.json")?.value || null,
    endMetrics: artifactMap.get("browser/end/performance-metrics.json")?.value || null
  }));

  const securityByOrigin = new Map();
  for (const item of requests) {
    const response = item.response || {};
    if (!response.securityDetails) continue;
    let origin = response.url || item.request?.url || "";
    try { origin = new URL(origin).origin; } catch (_) { }
    securityByOrigin.set(origin, {
      origin,
      protocol: response.protocol || null,
      remoteIPAddress: response.remoteIPAddress || null,
      remotePort: response.remotePort || null,
      securityState: response.securityState || null,
      securityDetails: response.securityDetails
    });
  }
  zip.addFile("security.json", jsonBytes(Array.from(securityByOrigin.values())));

  const statusCounts = {};
  const typeCounts = {};
  for (const item of requests) {
    const status = String(item.response?.status || (item.loadingFailed ? "failed" : "no-response"));
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const type = item.type || "Other";
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  const missingBodyCount = resourceManifest.filter((item) => item.status && item.status !== 204 && !item.bodyCaptured && !item.loadingFailed).length;
  const completeness = {
    networkEvents: true,
    requestBodies: bodies.some((item) => item.kind === "request"),
    responseBodiesCaptured: bodies.filter((item) => item.kind === "response").length,
    responseBodiesUnavailable: bodyWarnings.length,
    resourceBodiesMissingEstimate: missingBodyCount,
    downloads: { detected: downloads.length, complete: capturedDownloadFiles, metadataOnly: metadataOnlyDownloads },
    pageBlobs: { detected: pageBlobs.length, complete: capturedPageBlobs, incomplete: Math.max(0, pageBlobs.length - capturedPageBlobs) },
    cookies: { start: cookieStart.length, end: cookieEnd.length },
    localStorage: Boolean(pageEnd.localStorage),
    sessionStorage: Boolean(pageEnd.sessionStorage),
    indexedDB: Boolean(artifactMap.get("browser/end/web-storage-deep.json")?.value?.indexedDB),
    cacheStorage: Boolean(artifactMap.get("browser/end/web-storage-deep.json")?.value?.cacheStorage),
    domHtml: artifactMap.has("page/page.html"),
    domSnapshot: artifactMap.has("page/dom-snapshot.json"),
    mhtml: artifactMap.has("page/page.mhtml"),
    screenshots: { start: artifactMap.has("screenshots/start.png"), end: artifactMap.has("screenshots/end.png") },
    consoleEvents: consoleEvents.length,
    javascriptErrors: jsErrors.length,
    userActions: actions.length,
    domMutationBatches: domMutations.length,
    targetsObserved: targets.length,
    chromiumTracing: {
      requested: Boolean(session.tracing?.requested),
      status: session.tracing?.status || "disabled",
      file: traceParts.length > 0 ? "tracing/chromium-trace.json" : null,
      chunks: traceParts.length,
      capturedBytes: traceBytes,
      dataLossOccurred: session.tracing?.dataLossOccurred ?? null,
      error: session.tracing?.error || null
    },
    warnings: warnings.length
  };

  const manifest = {
    format: "browser-session-capture",
    formatVersion: 2,
    session: {
      id: session.id,
      tabId: session.tabId,
      startUrl: session.startUrl,
      startTime: session.startTime,
      endTime: session.endTime,
      stopReason: session.stopReason,
      captureEngine: session.captureEngine,
      extensionVersion: session.extensionVersion,
      chromiumTracing: session.tracing || { requested: false, status: "disabled" }
    },
    counts: {
      rawEvents: events.length,
      requests: requests.length,
      requestBodies: bodies.filter((item) => item.kind === "request").length,
      responseBodies: bodies.filter((item) => item.kind === "response").length,
      resources: resourceManifest.length,
      scripts: scriptManifest.length,
      realtimeEvents: realtime.length,
      actions: actions.length,
      consoleEvents: consoleEvents.length,
      javascriptErrors: jsErrors.length,
      domMutationBatches: domMutations.length,
      apiRequests: apiSummary.length,
      downloadsDetected: downloads.length,
      downloadedFilesCaptured: capturedDownloadFiles,
      downloadsMetadataOnly: metadataOnlyDownloads,
      pageBlobsDetected: pageBlobs.length,
      pageBlobsCaptured: capturedPageBlobs,
      tracingChunks: traceParts.length,
      tracingBytes: traceBytes,
      warnings: warnings.length
    },
    completeness,
    statusCounts,
    resourceTypeCounts: typeCounts,
    notes: [
      "raw-events.json is the primary event evidence stream. Derived files do not replace it.",
      "network.har, requests.json, actions.json, navigation.json, console.json and other summaries are derived views.",
      "Browser state is captured at start/end where possible: cookies, localStorage, sessionStorage, performance, screenshots and page HTML.",
      "At session end the recorder also attempts IndexedDB, Cache Storage, storage quota, resource tree, MHTML and DOMSnapshot capture with explicit size/count limits.",
      "HTTP response bodies are saved when Chromium exposes them. Missing bodies are explicitly represented by warnings/events rather than silently assumed present.",
      "Downloads are captured through Network.streamResourceContent when possible. Blob URLs created by the page are independently streamed through a Runtime binding while recording.",
      "When Chromium Tracing is enabled in settings, the trace is requested with categories=* and record-as-much-as-possible, streamed through CDP IO, and saved as tracing/chromium-trace.json when available.",
      "Chromium Tracing can substantially increase browser load, IndexedDB usage and final ZIP size; session-manifest.json reports status, size and any known data loss.",
      "This archive may contain authentication tokens, cookies, form values, request/response bodies, downloaded files and other sensitive session data."
    ]
  };

  const har = makeHar(session, requests);
  const requestsForExport = requests.map((item) => {
    const copy = { ...item };
    delete copy._requestBody;
    delete copy._responseBody;
    return copy;
  });
  zip.addFile("session-manifest.json", jsonBytes(manifest));
  zip.addFile("raw-events.json", jsonBytes(events));
  zip.addFile("requests.json", jsonBytes(requestsForExport));
  zip.addFile("network.har", jsonBytes(har));

  const blob = zip.buildBlob();
  const filename = `Browser-Network-${filenameStamp(session.startTime)}.zip`;
  const token = `${sessionId}-${Math.random().toString(16).slice(2)}`;
  const blobUrl = URL.createObjectURL(blob);
  objectUrls.set(token, blobUrl);
  chrome.runtime.sendMessage({
    type: "offscreen:ready",
    sessionId,
    tabId,
    blobUrl,
    filename,
    token
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "offscreen") {
    return;
  }

  if (message.type === "offscreen:export") {
    exportSession(message.sessionId, message.tabId).catch((error) => {
      chrome.runtime.sendMessage({
        type: "offscreen:error",
        sessionId: message.sessionId,
        tabId: message.tabId,
        error: error?.message || String(error)
      });
    });
    return;
  }

  if (message.type === "offscreen:revoke") {
    const url = objectUrls.get(message.token);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrls.delete(message.token);
    }
  }
});
