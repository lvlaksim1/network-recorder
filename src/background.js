"use strict";

const DB_NAME = "einv-network-recorder";
const DB_VERSION = 4;
const ACTIVE_KEY = "einvNetworkRecorderActiveSessions";
const PENDING_DOWNLOADS_KEY = "einvNetworkRecorderPendingDownloads";
const OFFSCREEN_PATH = "offscreen.html";
const TRACING_PREF_KEY = "chromiumTracingEnabled";
const API_BODIES_PREF_KEY = "captureApiBodiesEnabled";
const PAGE_RESOURCES_PREF_KEY = "capturePageResourcesEnabled";
const ALL_RESOURCE_BODIES_PREF_KEY = "captureAllResourceBodiesEnabled";
const FILES_BLOBS_PREF_KEY = "captureFilesAndBlobsEnabled";
const DEEP_DIAGNOSTICS_PREF_KEY = "captureDeepDiagnosticsEnabled";
const CAPTURE_PREF_KEYS = [TRACING_PREF_KEY, API_BODIES_PREF_KEY, PAGE_RESOURCES_PREF_KEY, ALL_RESOURCE_BODIES_PREF_KEY, FILES_BLOBS_PREF_KEY, DEEP_DIAGNOSTICS_PREF_KEY];
const CAPTURE_DEFAULTS = Object.freeze({ tracingEnabled: false, apiBodies: true, pageResources: true, allResourceBodies: false, filesAndBlobs: false, deepDiagnostics: false });
const NETWORK_BUFFER_TOTAL = 100 * 1024 * 1024;
const NETWORK_BUFFER_RESOURCE = 25 * 1024 * 1024;
const NETWORK_POST_DATA = 10 * 1024 * 1024;
const TRACE_READ_CHUNK = 1024 * 1024;
const TRACE_STOP_TIMEOUT = 60 * 1000;

let offscreenCreating = null;
const recentRequestByUrl = new Map();
const requestCaptureInfo = new Map();
const sessionCaptureOptionsCache = new Map();
const downloadStreamStarting = new Set();
const tracingCompletionWaiters = new Map();
const textEncoder = new TextEncoder();

function chromeError(prefix) {
  const error = chrome.runtime.lastError;
  return new Error(error ? `${prefix}: ${error.message}` : prefix);
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(chromeError("Ошибка chrome.storage.local.set"));
        return;
      }
      resolve();
    });
  });
}
function normalizeCaptureOptions(value = {}) {
  return {
    tracingEnabled: value.tracingEnabled == null ? CAPTURE_DEFAULTS.tracingEnabled : Boolean(value.tracingEnabled),
    apiBodies: value.apiBodies == null ? CAPTURE_DEFAULTS.apiBodies : Boolean(value.apiBodies),
    pageResources: value.pageResources == null ? CAPTURE_DEFAULTS.pageResources : Boolean(value.pageResources),
    allResourceBodies: value.allResourceBodies == null ? CAPTURE_DEFAULTS.allResourceBodies : Boolean(value.allResourceBodies),
    filesAndBlobs: value.filesAndBlobs == null ? CAPTURE_DEFAULTS.filesAndBlobs : Boolean(value.filesAndBlobs),
    deepDiagnostics: value.deepDiagnostics == null ? CAPTURE_DEFAULTS.deepDiagnostics : Boolean(value.deepDiagnostics)
  };
}

async function getStoredCaptureOptions() {
  const stored = await storageGet(CAPTURE_PREF_KEYS);
  return normalizeCaptureOptions({
    tracingEnabled: stored[TRACING_PREF_KEY],
    apiBodies: stored[API_BODIES_PREF_KEY],
    pageResources: stored[PAGE_RESOURCES_PREF_KEY],
    allResourceBodies: stored[ALL_RESOURCE_BODIES_PREF_KEY],
    filesAndBlobs: stored[FILES_BLOBS_PREF_KEY],
    deepDiagnostics: stored[DEEP_DIAGNOSTICS_PREF_KEY]
  });
}

async function getSessionCaptureOptions(sessionId) {
  if (sessionCaptureOptionsCache.has(sessionId)) return sessionCaptureOptionsCache.get(sessionId);
  const session = await dbGet("sessions", sessionId);
  const options = normalizeCaptureOptions(session?.captureOptions || {});
  sessionCaptureOptionsCache.set(sessionId, options);
  return options;
}

function requestCaptureKey(sessionId, source, requestId) {
  return sessionId + "|" + (source?.sessionId || "root") + "|" + (requestId || "");
}

function getRequestCaptureInfo(sessionId, source, requestId) {
  return requestCaptureInfo.get(requestCaptureKey(sessionId, source, requestId)) || { type: null, url: "", method: "", mimeType: "", status: null };
}

function isTextualResponse(info) {
  const mime = String(info?.mimeType || "").toLowerCase();
  const type = String(info?.type || "").toLowerCase();
  if (["document", "script", "stylesheet", "manifest", "texttrack"].includes(type)) return true;
  return /(^text\\/|json|javascript|ecmascript|xml|svg|x-www-form-urlencoded)/i.test(mime);
}

function responseBodyPolicy(options, info) {
  const type = String(info?.type || "").toLowerCase();
  if (options.allResourceBodies) return { capture: true, reason: "all-resource-bodies" };
  if (type === "xhr" || type === "fetch") return options.apiBodies ? { capture: true, reason: "api-body" } : { capture: false, reason: "api-bodies-disabled" };
  if (options.pageResources && isTextualResponse(info)) return { capture: true, reason: "text-page-resource" };
  return { capture: false, reason: "metadata-only-resource" };
}

function requestBodyPolicy(options, info) {
  const type = String(info?.type || "").toLowerCase();
  if (type === "xhr" || type === "fetch") return Boolean(options.apiBodies);
  return Boolean(options.allResourceBodies || (options.pageResources && isTextualResponse(info)));
}

function cleanupCaptureCaches(sessionId) {
  sessionCaptureOptionsCache.delete(sessionId);
  for (const key of requestCaptureInfo.keys()) {
    if (key.startsWith(sessionId + "|")) requestCaptureInfo.delete(key);
  }
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(chromeError("Не удалось подключить debugger"));
        return;
      }
      resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      if (chrome.runtime.lastError) {
        reject(chromeError("Не удалось отключить debugger"));
        return;
      }
      resolve();
    });
  });
}

function debuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(chromeError(`CDP ${method}`));
        return;
      }
      resolve(result || {});
    });
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains("bodies")) {
        const store = db.createObjectStore("bodies", { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains("downloads")) {
        const store = db.createObjectStore("downloads", { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("chromeDownloadId", "chromeDownloadId", { unique: false });
      }
      if (!db.objectStoreNames.contains("downloadChunks")) {
        const store = db.createObjectStore("downloadChunks", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("requestKey", "requestKey", { unique: false });
      }
      if (!db.objectStoreNames.contains("artifacts")) {
        const store = db.createObjectStore("artifacts", { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("name", "name", { unique: false });
      }
      if (!db.objectStoreNames.contains("warnings")) {
        const store = db.createObjectStore("warnings", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains("pageBlobs")) {
        const store = db.createObjectStore("pageBlobs", { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("objectUrl", "objectUrl", { unique: false });
      }
      if (!db.objectStoreNames.contains("pageBlobChunks")) {
        const store = db.createObjectStore("pageBlobChunks", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("blobKey", "blobKey", { unique: false });
      }
      if (!db.objectStoreNames.contains("traceChunks")) {
        const store = db.createObjectStore("traceChunks", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function dbPut(storeName, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error(`IndexedDB put failed: ${storeName}`));
      tx.onabort = () => reject(tx.error || new Error(`IndexedDB put aborted: ${storeName}`));
    });
  } finally {
    db.close();
  }
}

async function dbAdd(storeName, value) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const request = tx.objectStore(storeName).add(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`IndexedDB add failed: ${storeName}`));
      tx.onabort = () => reject(tx.error || new Error(`IndexedDB add aborted: ${storeName}`));
    });
  } finally {
    db.close();
  }
}

async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).index(indexName).get(value);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`IndexedDB index get failed: ${storeName}.${indexName}`));
    });
  } finally {
    db.close();
  }
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

async function addRawEvent(sessionId, source, method, params) {
  await dbPut("events", {
    sessionId,
    capturedAt: new Date().toISOString(),
    source: {
      tabId: source?.tabId ?? null,
      sessionId: source?.sessionId ?? null,
      targetId: source?.targetId ?? null
    },
    method,
    params: params ?? {}
  });
}


async function addWarning(sessionId, code, message, detail = null) {
  await dbAdd("warnings", {
    sessionId,
    capturedAt: new Date().toISOString(),
    code,
    message,
    detail
  });
}

async function putArtifact(sessionId, name, value, encoding = "json", metadata = null) {
  await dbPut("artifacts", {
    key: `${sessionId}|${name}`,
    sessionId,
    name,
    capturedAt: new Date().toISOString(),
    encoding,
    value,
    metadata
  });
}

async function evaluateValue(target, expression, options = {}) {
  const result = await debuggerCommand(target, "Runtime.evaluate", {
    expression,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: true,
    silent: true
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Runtime.evaluate failed";
    throw new Error(text);
  }
  return result.result?.value;
}

async function enableRuntimeLogPerformance(target) {
  for (const method of ["Runtime.enable", "Log.enable", "Performance.enable"]) {
    try { await debuggerCommand(target, method, {}); } catch (_) { }
  }
}

function base64ToBytes(text) {
  const binary = atob(text || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function traceDataToBytes(data, base64Encoded) {
  return base64Encoded ? base64ToBytes(data || "") : textEncoder.encode(data || "");
}

function createTracingCompletionWaiter(tabId) {
  const existing = tracingCompletionWaiters.get(tabId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error("Chromium Tracing waiter was replaced."));
    tracingCompletionWaiters.delete(tabId);
  }

  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    tracingCompletionWaiters.delete(tabId);
    rejectPromise(new Error("Таймаут ожидания Tracing.tracingComplete."));
  }, TRACE_STOP_TIMEOUT);

  const record = {
    timer,
    resolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tracingCompletionWaiters.delete(tabId);
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tracingCompletionWaiters.delete(tabId);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  };
  tracingCompletionWaiters.set(tabId, record);
  return { promise, cancel: (error) => record.reject(error || new Error("Chromium Tracing cancelled.")) };
}

function rejectTracingCompletion(tabId, error) {
  const waiter = tracingCompletionWaiters.get(tabId);
  if (waiter) waiter.reject(error || new Error("Chromium Tracing interrupted."));
}

async function startChromiumTracing(session, target) {
  session.tracing = {
    requested: true,
    status: "starting",
    startedAt: null,
    completedAt: null,
    categories: "*",
    recordMode: "record-as-much-as-possible",
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "none",
    dataLossOccurred: null,
    chunks: 0,
    capturedBytes: 0,
    error: null
  };
  await dbPut("sessions", session);

  try {
    await debuggerCommand(target, "Tracing.start", {
      categories: "*",
      options: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "none"
    });
    session.tracing.status = "active";
    session.tracing.startedAt = new Date().toISOString();
    await dbPut("sessions", session);
    await addRawEvent(session.id, target, "Recorder.tracingStarted", {
      categories: "*",
      recordMode: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "none"
    });
  } catch (error) {
    session.tracing.status = "start-failed";
    session.tracing.error = error?.message || String(error);
    session.tracing.completedAt = new Date().toISOString();
    await dbPut("sessions", session);
    await addWarning(session.id, "tracing-start-failed", "Не удалось запустить Chromium Tracing; обычная запись продолжена.", {
      error: session.tracing.error
    });
    await addRawEvent(session.id, target, "Recorder.tracingStartFailed", { error: session.tracing.error });
  }
}

async function stopChromiumTracing(session, target) {
  if (!session?.tracing?.requested || session.tracing.status !== "active") return;

  session.tracing.status = "stopping";
  await dbPut("sessions", session);
  const waiter = createTracingCompletionWaiter(target.tabId);
  let stream = null;
  let chunks = 0;
  let capturedBytes = 0;

  try {
    await debuggerCommand(target, "Tracing.end", {});
    const completed = await waiter.promise;
    stream = completed?.stream || null;
    session.tracing.dataLossOccurred = Boolean(completed?.dataLossOccurred);
    session.tracing.traceFormat = completed?.traceFormat || "json";
    session.tracing.traceCompression = completed?.streamCompression || "none";
    if (!stream) throw new Error("Tracing.tracingComplete не вернул stream handle.");

    while (true) {
      const part = await debuggerCommand(target, "IO.read", { handle: stream, size: TRACE_READ_CHUNK });
      const bytes = traceDataToBytes(part?.data || "", Boolean(part?.base64Encoded));
      if (bytes.byteLength > 0) {
        await dbAdd("traceChunks", {
          sessionId: session.id,
          index: chunks,
          capturedAt: new Date().toISOString(),
          bytes
        });
        chunks += 1;
        capturedBytes += bytes.byteLength;
      }
      if (part?.eof) break;
    }

    session.tracing.status = "complete";
    session.tracing.completedAt = new Date().toISOString();
    session.tracing.chunks = chunks;
    session.tracing.capturedBytes = capturedBytes;
    session.tracing.error = null;
    await dbPut("sessions", session);
    await addRawEvent(session.id, target, "Recorder.tracingComplete", {
      dataLossOccurred: session.tracing.dataLossOccurred,
      chunks,
      capturedBytes,
      traceFormat: session.tracing.traceFormat,
      traceCompression: session.tracing.traceCompression
    });
    if (session.tracing.dataLossOccurred) {
      await addWarning(session.id, "tracing-data-loss", "Chromium сообщил о потере части trace-данных.", {
        capturedBytes,
        chunks
      });
    }
  } catch (error) {
    waiter.cancel(error);
    try { await waiter.promise; } catch (_) { }
    session.tracing.status = capturedBytes > 0 ? "partial" : "failed";
    session.tracing.completedAt = new Date().toISOString();
    session.tracing.chunks = chunks;
    session.tracing.capturedBytes = capturedBytes;
    session.tracing.error = error?.message || String(error);
    await dbPut("sessions", session);
    await addWarning(session.id, "tracing-stop-failed", "Не удалось полностью завершить или сохранить Chromium Tracing.", {
      error: session.tracing.error,
      capturedBytes,
      chunks
    });
    await addRawEvent(session.id, target, "Recorder.tracingFailed", {
      error: session.tracing.error,
      capturedBytes,
      chunks
    });
  } finally {
    if (stream) {
      try { await debuggerCommand(target, "IO.close", { handle: stream }); } catch (_) { }
    }
  }
}

const BLOB_BINDING = "__einvRecorderCapture";

function pageBlobHookMain() {
  if (globalThis.__EINV_NR_BLOB_HOOK_INSTALLED__) {
    globalThis.__EINV_NR_CAPTURE_ACTIVE__ = true;
    return;
  }
  globalThis.__EINV_NR_BLOB_HOOK_INSTALLED__ = true;
  globalThis.__EINV_NR_CAPTURE_ACTIVE__ = true;
  const send = (payload) => {
    try {
      const fn = globalThis.__einvRecorderCapture;
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (_) { }
  };
  const bytesToBase64 = (bytes) => {
    let out = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(out);
  };
  const captureBlob = async (blob, objectUrl) => {
    const blobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    send({ kind: "blob-meta", blobId, objectUrl, mimeType: blob.type || "", size: blob.size || 0, createdAt: new Date().toISOString() });
    let index = 0;
    let total = 0;
    try {
      if (blob.stream && typeof blob.stream === "function") {
        const reader = blob.stream().getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!globalThis.__EINV_NR_CAPTURE_ACTIVE__) {
            try { await reader.cancel(); } catch (_) { }
            throw new Error("capture-stopped");
          }
          const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
          total += bytes.byteLength;
          send({ kind: "blob-chunk", blobId, index, data: bytesToBase64(bytes) });
          index += 1;
        }
      } else {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const chunkSize = 128 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          if (!globalThis.__EINV_NR_CAPTURE_ACTIVE__) throw new Error("capture-stopped");
          const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
          total += chunk.byteLength;
          send({ kind: "blob-chunk", blobId, index, data: bytesToBase64(chunk) });
          index += 1;
        }
      }
      send({ kind: "blob-complete", blobId, chunks: index, capturedBytes: total, completedAt: new Date().toISOString() });
    } catch (error) {
      send({ kind: "blob-error", blobId, error: error?.message || String(error), capturedBytes: total });
    }
  };
  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function(value) {
    const objectUrl = originalCreate(value);
    if (globalThis.__EINV_NR_CAPTURE_ACTIVE__ && typeof Blob !== "undefined" && value instanceof Blob) {
      captureBlob(value, objectUrl);
    }
    return objectUrl;
  };
  send({ kind: "hook-ready", at: new Date().toISOString(), href: location.href });
}

function blobHookSource() {
  return `(${pageBlobHookMain.toString()})();`;
}

async function installBlobHook(target, sessionId, source) {
  try {
    await debuggerCommand(target, "Runtime.addBinding", { name: BLOB_BINDING });
    const sourceCode = blobHookSource();
    try {
      await debuggerCommand(target, "Page.addScriptToEvaluateOnNewDocument", { source: sourceCode, runImmediately: true });
    } catch (_) {
      try { await debuggerCommand(target, "Page.addScriptToEvaluateOnNewDocument", { source: sourceCode }); } catch (_) { }
    }
    try { await evaluateValue(target, sourceCode, { awaitPromise: false }); } catch (_) { }
  } catch (error) {
    await addWarning(sessionId, "blob-hook-unavailable", "Не удалось включить перехват blob:-файлов.", error?.message || String(error));
    await addRawEvent(sessionId, source, "Recorder.blobHookUnavailable", { error: error?.message || String(error) });
  }
}

async function disableBlobHook(tabId) {
  try { await evaluateValue({ tabId }, "globalThis.__EINV_NR_CAPTURE_ACTIVE__ = false; true", { awaitPromise: false }); } catch (_) { }
}

function pageBasicSnapshotMain() {
  const warnings = [];
  const safeStorage = (storage, label) => {
    const out = {};
    let total = 0;
    const maxTotal = 10 * 1024 * 1024;
    const maxValue = 1024 * 1024;
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        let value = storage.getItem(key);
        if (typeof value !== "string") value = String(value ?? "");
        const originalLength = value.length;
        if (value.length > maxValue) {
          value = value.slice(0, maxValue);
          warnings.push(`${label}:${key}: value truncated from ${originalLength} chars`);
        }
        if (total + value.length > maxTotal) {
          warnings.push(`${label}: total size limit reached`);
          break;
        }
        total += value.length;
        out[key] = value;
      }
    } catch (error) {
      warnings.push(`${label}: ${error?.message || String(error)}`);
    }
    return out;
  };
  const html = document.documentElement?.outerHTML || "";
  const maxHtml = 20 * 1024 * 1024;
  const resources = performance.getEntriesByType("resource").slice(-5000).map((entry) => entry.toJSON ? entry.toJSON() : {
    name: entry.name,
    initiatorType: entry.initiatorType,
    startTime: entry.startTime,
    duration: entry.duration,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize
  });
  const navigation = performance.getEntriesByType("navigation").map((entry) => entry.toJSON ? entry.toJSON() : {
    name: entry.name,
    startTime: entry.startTime,
    duration: entry.duration
  });
  return JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    platform: navigator.platform,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1, scrollX, scrollY },
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    documentCookie: document.cookie,
    localStorage: safeStorage(localStorage, "localStorage"),
    sessionStorage: safeStorage(sessionStorage, "sessionStorage"),
    performance: { timeOrigin: performance.timeOrigin, navigation, resources },
    html: html.length > maxHtml ? html.slice(0, maxHtml) : html,
    htmlOriginalLength: html.length,
    htmlTruncated: html.length > maxHtml,
    warnings
  });
}

function basicSnapshotExpression() {
  return `(${pageBasicSnapshotMain.toString()})();`;
}

async function pageHeavyStorageMain() {
  const result = {
    capturedAt: new Date().toISOString(),
    indexedDB: [],
    cacheStorage: [],
    warnings: [],
    limits: {
      indexedDbRecordsPerStore: 1000,
      indexedDbSerializedCharsPerStore: 4000000,
      cacheRequestsPerCache: 250,
      cacheBodyBytes: 1000000
    }
  };
  const toJsonSafe = (value) => {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (key, item) => {
      if (typeof item === "bigint") return { __type: "bigint", value: item.toString() };
      if (item instanceof Date) return { __type: "date", value: item.toISOString() };
      if (item instanceof Blob) return { __type: "blob", size: item.size, type: item.type };
      if (item instanceof ArrayBuffer) return { __type: "arraybuffer", byteLength: item.byteLength };
      if (ArrayBuffer.isView(item)) return { __type: item.constructor?.name || "typedarray", byteLength: item.byteLength };
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
    return text == null ? null : JSON.parse(text);
  };
  const requestPromise = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
  try {
    if (indexedDB.databases) {
      const dbInfos = await indexedDB.databases();
      for (const info of dbInfos) {
        if (!info?.name) continue;
        const dbItem = { name: info.name, version: info.version ?? null, stores: [], error: null };
        try {
          const db = await requestPromise(indexedDB.open(info.name));
          for (const storeName of Array.from(db.objectStoreNames)) {
            const storeItem = { name: storeName, keyPath: null, autoIncrement: false, indexes: [], records: [], truncated: false, error: null };
            try {
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              storeItem.keyPath = store.keyPath;
              storeItem.autoIncrement = store.autoIncrement;
              storeItem.indexes = Array.from(store.indexNames).map((name) => {
                const idx = store.index(name);
                return { name, keyPath: idx.keyPath, multiEntry: idx.multiEntry, unique: idx.unique };
              });
              await new Promise((resolve, reject) => {
                const req = store.openCursor();
                let count = 0;
                let chars = 0;
                req.onerror = () => reject(req.error || new Error("Cursor failed"));
                req.onsuccess = () => {
                  const cursor = req.result;
                  if (!cursor) { resolve(); return; }
                  if (count >= 1000 || chars >= 4000000) { storeItem.truncated = true; resolve(); return; }
                  let row;
                  try { row = { key: toJsonSafe(cursor.key), primaryKey: toJsonSafe(cursor.primaryKey), value: toJsonSafe(cursor.value) }; }
                  catch (error) { row = { key: String(cursor.key), value: `[unserializable: ${error?.message || String(error)}]` }; }
                  const text = JSON.stringify(row);
                  chars += text.length;
                  if (chars > 4000000) { storeItem.truncated = true; resolve(); return; }
                  storeItem.records.push(row);
                  count += 1;
                  cursor.continue();
                };
              });
            } catch (error) {
              storeItem.error = error?.message || String(error);
            }
            dbItem.stores.push(storeItem);
          }
          db.close();
        } catch (error) {
          dbItem.error = error?.message || String(error);
        }
        result.indexedDB.push(dbItem);
      }
    } else {
      result.warnings.push("indexedDB.databases() is unavailable");
    }
  } catch (error) {
    result.warnings.push(`IndexedDB snapshot failed: ${error?.message || String(error)}`);
  }

  const bytesToBase64 = (bytes) => {
    let out = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(out);
  };
  const readLimited = async (response, maxBytes) => {
    if (!response.body || !response.body.getReader) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) return { omitted: true, reason: "body-too-large", byteLength: buffer.byteLength };
      return { omitted: false, bytes: new Uint8Array(buffer), byteLength: buffer.byteLength };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
      total += bytes.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) { }
        return { omitted: true, reason: "body-too-large", byteLength: total };
      }
      chunks.push(bytes);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) { merged.set(part, offset); offset += part.length; }
    return { omitted: false, bytes: merged, byteLength: total };
  };
  try {
    if (globalThis.caches) {
      for (const cacheName of await caches.keys()) {
        const cacheItem = { name: cacheName, entries: [], truncated: false, error: null };
        try {
          const cache = await caches.open(cacheName);
          const requests = await cache.keys();
          if (requests.length > 250) cacheItem.truncated = true;
          for (const request of requests.slice(0, 250)) {
            try {
              const response = await cache.match(request);
              if (!response) continue;
              const headers = {};
              response.headers.forEach((value, key) => { headers[key] = value; });
              const body = await readLimited(response.clone(), 1000000);
              const contentType = response.headers.get("content-type") || "";
              const textual = /(^text\/|json|javascript|xml|svg|x-www-form-urlencoded)/i.test(contentType);
              const entry = {
                request: { url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
                response: { status: response.status, statusText: response.statusText, type: response.type, redirected: response.redirected, url: response.url, headers },
                body: null
              };
              if (body.omitted) entry.body = { omitted: true, reason: body.reason, observedBytes: body.byteLength };
              else if (textual) entry.body = { omitted: false, encoding: "utf-8", text: new TextDecoder().decode(body.bytes), byteLength: body.byteLength };
              else entry.body = { omitted: false, encoding: "base64", data: bytesToBase64(body.bytes), byteLength: body.byteLength };
              cacheItem.entries.push(entry);
            } catch (error) {
              cacheItem.entries.push({ error: error?.message || String(error) });
            }
          }
        } catch (error) {
          cacheItem.error = error?.message || String(error);
        }
        result.cacheStorage.push(cacheItem);
      }
    } else {
      result.warnings.push("CacheStorage is unavailable");
    }
  } catch (error) {
    result.warnings.push(`CacheStorage snapshot failed: ${error?.message || String(error)}`);
  }
  return JSON.stringify(result);
}

function heavyStorageExpression() {
  return `(${pageHeavyStorageMain.toString()})();`;
}

async function captureBasicSnapshot(sessionId, tabId, phase) {
  const target = { tabId };
  try {
    const raw = await evaluateValue(target, basicSnapshotExpression());
    const snapshot = JSON.parse(raw || "{}");
    const html = typeof snapshot.html === "string" ? snapshot.html : "";
    delete snapshot.html;
    await putArtifact(sessionId, `browser/${phase}/page-snapshot.json`, snapshot, "json");
    if (html) await putArtifact(sessionId, phase === "end" ? "page/page.html" : "page/start.html", html, "text");
    for (const warning of snapshot.warnings || []) await addWarning(sessionId, `${phase}-snapshot-warning`, warning);
  } catch (error) {
    await addWarning(sessionId, `${phase}-page-snapshot-failed`, `Не удалось сохранить ${phase} snapshot страницы.`, error?.message || String(error));
  }
  try {
    const cookies = await debuggerCommand(target, "Network.getCookies", {});
    await putArtifact(sessionId, `browser/${phase}/cookies.json`, cookies.cookies || [], "json");
  } catch (error) {
    await addWarning(sessionId, `${phase}-cookies-failed`, "Не удалось сохранить cookies.", error?.message || String(error));
  }
  try {
    const metrics = await debuggerCommand(target, "Performance.getMetrics", {});
    await putArtifact(sessionId, `browser/${phase}/performance-metrics.json`, metrics, "json");
  } catch (error) {
    await addWarning(sessionId, `${phase}-performance-failed`, "Не удалось сохранить Performance metrics.", error?.message || String(error));
  }
  try {
    const screenshot = await debuggerCommand(target, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    if (screenshot.data) await putArtifact(sessionId, `screenshots/${phase}.png`, screenshot.data, "base64");
  } catch (error) {
    await addWarning(sessionId, `${phase}-screenshot-failed`, "Не удалось сделать снимок страницы.", error?.message || String(error));
  }
}

async function captureHeavySnapshot(sessionId, tabId) {
  const target = { tabId };
  try {
    const raw = await evaluateValue(target, heavyStorageExpression());
    const snapshot = JSON.parse(raw || "{}");
    await putArtifact(sessionId, "browser/end/web-storage-deep.json", snapshot, "json");
    for (const warning of snapshot.warnings || []) await addWarning(sessionId, "storage-snapshot-warning", warning);
  } catch (error) {
    await addWarning(sessionId, "storage-snapshot-failed", "Не удалось сохранить IndexedDB/Cache Storage.", error?.message || String(error));
  }
  try {
    const origin = await evaluateValue(target, "location.origin");
    if (typeof origin !== "string" || !origin || origin === "null") {
      throw new Error("Текущая страница не имеет обычного origin.");
    }
    const usage = await debuggerCommand(target, "Storage.getUsageAndQuota", { origin });
    await putArtifact(sessionId, "browser/end/storage-usage.json", usage, "json", { origin });
  } catch (error) {
    await addWarning(sessionId, "storage-usage-failed", "Не удалось получить сведения об использовании browser storage.", error?.message || String(error));
  }
  try {
    const tree = await debuggerCommand(target, "Page.getResourceTree", {});
    await putArtifact(sessionId, "browser/end/resource-tree.json", tree, "json");
  } catch (error) {
    await addWarning(sessionId, "resource-tree-failed", "Не удалось сохранить дерево ресурсов страницы.", error?.message || String(error));
  }
  try {
    const mhtml = await debuggerCommand(target, "Page.captureSnapshot", { format: "mhtml" });
    if (mhtml.data) {
      if (mhtml.data.length <= 50 * 1024 * 1024) {
        await putArtifact(sessionId, "page/page.mhtml", mhtml.data, "text");
      } else {
        await addWarning(sessionId, "mhtml-too-large", "MHTML snapshot не включён: превышен лимит 50 МБ.", { chars: mhtml.data.length });
      }
    }
  } catch (error) {
    await addWarning(sessionId, "mhtml-failed", "Не удалось сохранить MHTML snapshot.", error?.message || String(error));
  }
  try {
    const dom = await debuggerCommand(target, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false
    });
    const domSize = JSON.stringify(dom).length;
    if (domSize <= 50 * 1024 * 1024) {
      await putArtifact(sessionId, "page/dom-snapshot.json", dom, "json");
    } else {
      await addWarning(sessionId, "dom-snapshot-too-large", "DOMSnapshot не включён: превышен лимит 50 МБ.", { chars: domSize });
    }
  } catch (error) {
    await addWarning(sessionId, "dom-snapshot-failed", "Не удалось сохранить DOMSnapshot.", error?.message || String(error));
  }
}

async function getActiveSessions() {
  const result = await storageGet(ACTIVE_KEY);
  return result[ACTIVE_KEY] || {};
}

async function setActiveSessions(sessions) {
  await storageSet({ [ACTIVE_KEY]: sessions });
}

async function getActiveSessionId(tabId) {
  const sessions = await getActiveSessions();
  return sessions[String(tabId)] || null;
}

async function setActiveSession(tabId, sessionId) {
  const sessions = await getActiveSessions();
  if (sessionId) {
    sessions[String(tabId)] = sessionId;
  } else {
    delete sessions[String(tabId)];
  }
  await setActiveSessions(sessions);
}

async function updateActionState(tabId, state, detail = "") {
  if (!Number.isInteger(tabId) || !chrome.action) return;
  const badge = state === "recording" ? "REC" : state === "exporting" ? "…" : state === "error" ? "ERR" : "";
  const title = state === "recording"
    ? "Идёт запись активности этой вкладки. Нажмите, чтобы остановить."
    : state === "exporting"
      ? "Формируется ZIP записи…"
      : state === "error"
        ? `Ошибка записи${detail ? `: ${detail}` : ""}`
        : "Запись активности текущей вкладки";
  try { await chrome.action.setBadgeText({ tabId, text: badge }); } catch (_) { }
  try { await chrome.action.setTitle({ tabId, title }); } catch (_) { }
}

async function notifyTab(tabId, state, detail = "") {
  await updateActionState(tabId, state, detail);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "capture:state", state, detail }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function requestTab(tabId, message) {
  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chromeError("Не удалось связаться со страницей"));
        return;
      }
      resolve(response);
    });
  });
}



async function enableNetwork(target) {
  try {
    await debuggerCommand(target, "Network.enable", {
      maxTotalBufferSize: NETWORK_BUFFER_TOTAL,
      maxResourceBufferSize: NETWORK_BUFFER_RESOURCE,
      maxPostDataSize: NETWORK_POST_DATA,
      enableDurableMessages: true
    });
  } catch (firstError) {
    await debuggerCommand(target, "Network.enable", {});
  }
}

async function enablePageEvents(target) {
  try {
    await debuggerCommand(target, "Page.enable", {});
  } catch (_) {
    // Worker/service-worker targets do not expose the Page domain.
  }
}

async function enableAutoAttach(target) {
  try {
    await debuggerCommand(target, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
  } catch (_) {
    // Older Chromium forks may not expose flat child sessions. Root capture still works.
  }
}

function sourceKey(source) {
  return source?.sessionId || "root";
}

function downloadKey(sessionId, source, requestId) {
  return `${sessionId}|${sourceKey(source)}|${requestId}`;
}

function targetForSource(source) {
  return source?.sessionId
    ? { tabId: source.tabId, sessionId: source.sessionId }
    : { tabId: source.tabId };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return String(value ?? "");
  }
  return "";
}

function filenameFromContentDisposition(value) {
  const text = String(value || "");
  let match = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1].trim().replace(/^"|"$/g, "")); } catch (_) { }
  }
  match = text.match(/filename\s*=\s*"([^"]+)"/i) || text.match(/filename\s*=\s*([^;]+)/i);
  return match ? match[1].trim().replace(/^"|"$/g, "") : "";
}

function looksLikeDownloadResponse(params) {
  const response = params?.response || {};
  const disposition = headerValue(response.headers, "content-disposition");
  if (/\battachment\b/i.test(disposition)) return true;
  const mime = String(response.mimeType || "").toLowerCase();
  const type = String(params?.type || "");
  if (type === "Document" || type === "Other") {
    return mime === "application/octet-stream" || mime === "application/zip" || mime === "application/x-zip-compressed";
  }
  return false;
}

function rememberRequest(sessionId, source, params) {
  const url = params?.request?.url;
  if (!url || !params?.requestId) return;
  recentRequestByUrl.set(String(source.tabId) + "|" + url, {
    sessionId,
    source: { tabId: source.tabId, sessionId: source?.sessionId || null },
    requestId: params.requestId,
    url,
    seenAt: Date.now()
  });
  const key = requestCaptureKey(sessionId, source, params.requestId);
  const previous = requestCaptureInfo.get(key) || {};
  requestCaptureInfo.set(key, {
    ...previous,
    type: params?.type || previous.type || null,
    url,
    method: params?.request?.method || previous.method || "",
    mimeType: previous.mimeType || "",
    status: previous.status ?? null
  });
}

function rememberResponseUrl(sessionId, source, params) {
  const url = params?.response?.url;
  if (!url || !params?.requestId) return;
  recentRequestByUrl.set(String(source.tabId) + "|" + url, {
    sessionId,
    source: { tabId: source.tabId, sessionId: source?.sessionId || null },
    requestId: params.requestId,
    url,
    seenAt: Date.now()
  });
  const key = requestCaptureKey(sessionId, source, params.requestId);
  const previous = requestCaptureInfo.get(key) || {};
  requestCaptureInfo.set(key, {
    ...previous,
    type: params?.type || previous.type || null,
    url,
    method: previous.method || "",
    mimeType: params?.response?.mimeType || previous.mimeType || "",
    status: params?.response?.status ?? previous.status ?? null
  });
}

function findRecentRequest(tabId, url) {
  const item = recentRequestByUrl.get(`${tabId}|${url}`);
  if (!item) return null;
  if (Date.now() - item.seenAt > 60_000) {
    recentRequestByUrl.delete(`${tabId}|${url}`);
    return null;
  }
  return item;
}

function findRecentRequestAny(url) {
  if (!url) return null;
  let best = null;
  for (const item of recentRequestByUrl.values()) {
    if (item.url !== url) continue;
    if (Date.now() - item.seenAt > 60_000) continue;
    if (!best || item.seenAt > best.seenAt) best = item;
  }
  return best;
}

async function captureRequestPostData(sessionId, source, requestId) {
  const target = targetForSource(source);
  try {
    const request = await debuggerCommand(target, "Network.getRequestPostData", { requestId });
    if (typeof request.postData === "string" && request.postData.length > 0) {
      await dbPut("bodies", {
        key: bodyKey(sessionId, source, requestId, "request"),
        sessionId,
        sourceSessionId: source?.sessionId || null,
        requestId,
        kind: "request",
        capturedAt: new Date().toISOString(),
        base64Encoded: Boolean(request.base64Encoded),
        body: request.postData
      });
    }
  } catch (_) {
    // No request body is normal for GET/HEAD and many resource requests.
  }
}

async function startDownloadStream(sessionId, source, requestId, metadata = {}) {
  if (!requestId) return null;
  const key = downloadKey(sessionId, source, requestId);
  const existing = await dbGet("downloads", key);
  if (existing?.streamSupported) {
    const merged = { ...existing, ...metadata, key, sessionId, requestId, sourceSessionId: sourceKey(source) === "root" ? null : sourceKey(source) };
    await dbPut("downloads", merged);
    return merged;
  }
  if (downloadStreamStarting.has(key)) return existing;
  downloadStreamStarting.add(key);

  const record = {
    key,
    sessionId,
    sourceSessionId: sourceKey(source) === "root" ? null : sourceKey(source),
    requestId,
    tabId: source.tabId,
    url: metadata.url || "",
    mimeType: metadata.mimeType || "",
    contentDisposition: metadata.contentDisposition || "",
    suggestedFilename: metadata.suggestedFilename || filenameFromContentDisposition(metadata.contentDisposition),
    downloadGuid: metadata.downloadGuid || null,
    reason: metadata.reason || "detected-response",
    startedAt: existing?.startedAt || new Date().toISOString(),
    finishedAt: null,
    status: "starting",
    streamSupported: false,
    streamError: null,
    encodedDataLength: null,
    chromeDownloadId: existing?.chromeDownloadId ?? null,
    localFilename: existing?.localFilename || null,
    browserState: existing?.browserState || null,
    browserError: existing?.browserError || null
  };
  await dbPut("downloads", record);

  if (metadata.captureBytes === false) {
    record.status = "metadata-only";
    record.streamSupported = false;
    record.streamError = "Byte capture disabled by Network Recorder settings.";
    await dbPut("downloads", record);
    await addRawEvent(sessionId, source, "Recorder.downloadBodySkipped", {
      requestId,
      url: record.url,
      suggestedFilename: record.suggestedFilename,
      reason: "files-and-blobs-disabled"
    });
    return record;
  }

  try {
    const result = await debuggerCommand(targetForSource(source), "Network.streamResourceContent", { requestId });
    record.streamSupported = true;
    record.status = "streaming";
    await dbPut("downloads", record);
    if (typeof result.bufferedData === "string" && result.bufferedData.length > 0) {
      await dbAdd("downloadChunks", {
        sessionId,
        requestKey: key,
        sourceSessionId: record.sourceSessionId,
        requestId,
        capturedAt: new Date().toISOString(),
        data: result.bufferedData,
        buffered: true
      });
    }
    await addRawEvent(sessionId, source, "Recorder.downloadStreamStarted", {
      requestId,
      url: record.url,
      suggestedFilename: record.suggestedFilename,
      reason: record.reason,
      bufferedDataPresent: Boolean(result.bufferedData)
    });
  } catch (error) {
    record.status = "metadata-only";
    record.streamSupported = false;
    record.streamError = error?.message || String(error);
    await dbPut("downloads", record);
    await addRawEvent(sessionId, source, "Recorder.downloadStreamUnavailable", {
      requestId,
      url: record.url,
      suggestedFilename: record.suggestedFilename,
      error: record.streamError
    });
  } finally {
    downloadStreamStarting.delete(key);
  }
  return record;
}

async function updateDownloadRecord(sessionId, source, requestId, patch) {
  const key = downloadKey(sessionId, source, requestId);
  const record = await dbGet("downloads", key);
  if (!record) return null;
  Object.assign(record, patch);
  await dbPut("downloads", record);
  return record;
}

function bodyKey(sessionId, source, requestId, kind) {
  const child = source?.sessionId || "root";
  return `${sessionId}|${child}|${requestId}|${kind}`;
}

async function captureCompletedBodies(sessionId, source, requestId, options, info) {
  const target = targetForSource(source);
  const policy = responseBodyPolicy(options, info);

  if (policy.capture) {
    try {
      const response = await debuggerCommand(target, "Network.getResponseBody", { requestId });
      await dbPut("bodies", {
        key: bodyKey(sessionId, source, requestId, "response"),
        sessionId,
        sourceSessionId: source?.sessionId || null,
        requestId,
        kind: "response",
        capturedAt: new Date().toISOString(),
        base64Encoded: Boolean(response.base64Encoded),
        body: response.body || ""
      });
    } catch (error) {
      await addRawEvent(sessionId, source, "Recorder.responseBodyUnavailable", {
        requestId,
        error: error?.message || String(error)
      });
    }
  } else {
    await addRawEvent(sessionId, source, "Recorder.responseBodySkipped", {
      requestId,
      url: info?.url || "",
      type: info?.type || null,
      mimeType: info?.mimeType || "",
      reason: policy.reason
    });
  }

  if (requestBodyPolicy(options, info)) {
    await captureRequestPostData(sessionId, source, requestId);
  }
}

async function startCaptureasync function startCapture(tabId, url, options = {}) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Не удалось определить вкладку браузера.");
  }
  if (typeof url !== "string" || url.length === 0) {
    url = "about:blank";
  }
  const existing = await getActiveSessionId(tabId);
  if (existing) {
    return { state: "recording", sessionId: existing };
  }

  const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const session = {
    id: sessionId,
    tabId,
    startUrl: url,
    startTime: new Date().toISOString(),
    endTime: null,
    status: "starting",
    stopReason: null,
    exportFile: null,
    extensionVersion: chrome.runtime.getManifest().version,
    captureEngine: "chrome.debugger/CDP selective capture + optional deep diagnostics",
    captureOptions: normalizeCaptureOptions(options),
    tracing: {
      requested: Boolean(options?.tracingEnabled),
      status: options?.tracingEnabled ? "pending" : "disabled",
      startedAt: null,
      completedAt: null,
      categories: options?.tracingEnabled ? "*" : null,
      recordMode: options?.tracingEnabled ? "record-as-much-as-possible" : null,
      transferMode: options?.tracingEnabled ? "ReturnAsStream" : null,
      streamFormat: options?.tracingEnabled ? "json" : null,
      streamCompression: options?.tracingEnabled ? "none" : null,
      dataLossOccurred: null,
      chunks: 0,
      capturedBytes: 0,
      error: null
    }
  };
  await dbPut("sessions", session);
  sessionCaptureOptionsCache.set(sessionId, session.captureOptions);

  const target = { tabId };
  try {
    await debuggerAttach(target);
    await setActiveSession(tabId, sessionId);
    if (session.tracing.requested) {
      await startChromiumTracing(session, target);
    }
    await enableNetwork(target);
    await enablePageEvents(target);
    await enableRuntimeLogPerformance(target);
    await enableAutoAttach(target);
    if (session.captureOptions.filesAndBlobs) {
      await installBlobHook(target, sessionId, target);
    }

    await addRawEvent(sessionId, target, "Recorder.captureStarted", {
      tabId,
      url,
      startTime: session.startTime,
      captureVersion: 3,
      captureOptions: session.captureOptions,
      chromiumTracing: session.tracing?.requested ? session.tracing.status : "disabled"
    });
    await captureBasicSnapshot(sessionId, tabId, "start");

    session.status = "active";
    await dbPut("sessions", session);
    await notifyTab(tabId, "recording");
    return { state: "recording", sessionId };
  } catch (error) {
    session.status = "failed";
    session.endTime = new Date().toISOString();
    session.stopReason = error?.message || String(error);
    await dbPut("sessions", session);
    await setActiveSession(tabId, null);
    cleanupCaptureCaches(sessionId);
    try { await debuggerDetach(target); } catch (_) { }
    throw error;
  }
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  let exists = false;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    exists = contexts.length > 0;
  } else {
    const matchedClients = await clients.matchAll();
    exists = matchedClients.some((client) => client.url === offscreenUrl);
  }

  if (exists) {
    return;
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Create a ZIP Blob containing the captured network session and provide it for download."
  });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function requestExport(sessionId, tabId) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    type: "offscreen:export",
    target: "offscreen",
    sessionId,
    tabId
  });
}

async function stopCapture(tabId, reason = "user") {
  const sessionId = await getActiveSessionId(tabId);
  if (!sessionId) {
    return { state: "idle" };
  }

  const session = await dbGet("sessions", sessionId);
  if (!session) {
    await setActiveSession(tabId, null);
    return { state: "idle" };
  }

  session.status = "stopping";
  session.stopReason = reason;
  await dbPut("sessions", session);
  await notifyTab(tabId, "exporting");

  try {
    await addRawEvent(sessionId, { tabId }, "Recorder.captureStopping", { reason });
    await stopChromiumTracing(session, { tabId });
    if (session.captureOptions?.filesAndBlobs) await disableBlobHook(tabId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await captureBasicSnapshot(sessionId, tabId, "end");
    if (session.captureOptions?.deepDiagnostics) await captureHeavySnapshot(sessionId, tabId);
    try { await debuggerCommand({ tabId }, "Network.disable", {}); } catch (_) { }
    try { await debuggerDetach({ tabId }); } catch (_) { }
  } finally {
    await setActiveSession(tabId, null);
  }

  session.status = "captured";
  session.endTime = new Date().toISOString();
  await dbPut("sessions", session);
  cleanupCaptureCaches(sessionId);
  await requestExport(sessionId, tabId);
  return { state: "exporting", sessionId };
}

async function handleDebuggerEvent(source, method, params) {
  if (!source?.tabId) {
    return;
  }
  const sessionId = await getActiveSessionId(source.tabId);
  if (!sessionId) {
    return;
  }

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    const child = { tabId: source.tabId, sessionId: params.sessionId };
    await addRawEvent(sessionId, child, "Recorder.targetAttached", {
      targetInfo: params.targetInfo || null
    });
    try {
      await enableNetwork(child);
      await enablePageEvents(child);
      await enableRuntimeLogPerformance(child);
      await enableAutoAttach(child);
      const options = await getSessionCaptureOptions(sessionId);
      if (options.filesAndBlobs) await installBlobHook(child, sessionId, child);
    } catch (error) {
      await addRawEvent(sessionId, child, "Recorder.childTargetCaptureError", {
        error: error?.message || String(error),
        targetInfo: params.targetInfo || null
      });
    }
    return;
  }

  if (method === "Tracing.tracingComplete") {
    const waiter = tracingCompletionWaiters.get(source.tabId);
    if (waiter) waiter.resolve(params || {});
    await addRawEvent(sessionId, source, "Tracing.tracingComplete", {
      dataLossOccurred: Boolean(params?.dataLossOccurred),
      hasStream: Boolean(params?.stream),
      traceFormat: params?.traceFormat || null,
      streamCompression: params?.streamCompression || null
    });
    return;
  }

  if (method === "Runtime.bindingCalled" && params?.name === BLOB_BINDING) {
    const options = await getSessionCaptureOptions(sessionId);
    if (!options.filesAndBlobs) return;
    let payload = null;
    try { payload = JSON.parse(params.payload || "{}"); } catch (_) { payload = null; }
    if (!payload || typeof payload.kind !== "string") return;
    const blobKey = payload.blobId ? `${sessionId}|${payload.blobId}` : null;
    if (payload.kind === "hook-ready") {
      await addRawEvent(sessionId, source, "Recorder.blobHookReady", { href: payload.href || "", at: payload.at || null });
      return;
    }
    if (payload.kind === "blob-meta" && blobKey) {
      await dbPut("pageBlobs", {
        key: blobKey,
        sessionId,
        blobId: payload.blobId,
        objectUrl: payload.objectUrl || "",
        mimeType: payload.mimeType || "",
        size: payload.size ?? null,
        createdAt: payload.createdAt || new Date().toISOString(),
        completedAt: null,
        capturedBytes: 0,
        chunks: 0,
        status: "capturing",
        error: null,
        suggestedFilename: null
      });
      await addRawEvent(sessionId, source, "Recorder.pageBlobCreated", {
        blobId: payload.blobId,
        objectUrl: payload.objectUrl || "",
        mimeType: payload.mimeType || "",
        size: payload.size ?? null
      });
      return;
    }
    if (payload.kind === "blob-chunk" && blobKey) {
      await dbAdd("pageBlobChunks", {
        sessionId,
        blobKey,
        blobId: payload.blobId,
        index: payload.index ?? 0,
        data: payload.data || "",
        capturedAt: new Date().toISOString()
      });
      return;
    }
    if ((payload.kind === "blob-complete" || payload.kind === "blob-error") && blobKey) {
      const record = await dbGet("pageBlobs", blobKey);
      if (record) {
        record.status = payload.kind === "blob-complete" ? "complete" : "failed";
        record.completedAt = payload.completedAt || new Date().toISOString();
        record.capturedBytes = payload.capturedBytes ?? record.capturedBytes ?? 0;
        record.chunks = payload.chunks ?? record.chunks ?? 0;
        record.error = payload.error || null;
        await dbPut("pageBlobs", record);
      }
      await addRawEvent(sessionId, source,
        payload.kind === "blob-complete" ? "Recorder.pageBlobComplete" : "Recorder.pageBlobError",
        { blobId: payload.blobId, capturedBytes: payload.capturedBytes ?? 0, chunks: payload.chunks ?? 0, error: payload.error || null }
      );
      if (payload.kind === "blob-error" && payload.error !== "capture-stopped") {
        await addWarning(sessionId, "blob-capture-failed", "Не удалось полностью сохранить blob:-объект.", {
          blobId: payload.blobId,
          error: payload.error || null
        });
      }
      return;
    }
    return;
  }

  if (method === "Page.downloadWillBegin") {
    await addRawEvent(sessionId, source, method, params || {});
    const recent = findRecentRequest(source.tabId, params?.url || "");
    if (recent && recent.sessionId === sessionId) {
      const options = await getSessionCaptureOptions(sessionId);
      await startDownloadStream(sessionId, recent.source, recent.requestId, {
        url: params?.url || recent.url,
        suggestedFilename: params?.suggestedFilename || "",
        downloadGuid: params?.guid || null,
        reason: "Page.downloadWillBegin",
        captureBytes: options.filesAndBlobs
      });
    } else {
      const key = `${sessionId}|page-download|${params?.guid || Date.now()}`;
      await dbPut("downloads", {
        key,
        sessionId,
        sourceSessionId: source?.sessionId || null,
        requestId: null,
        tabId: source.tabId,
        url: params?.url || "",
        mimeType: "",
        contentDisposition: "",
        suggestedFilename: params?.suggestedFilename || "",
        downloadGuid: params?.guid || null,
        reason: "Page.downloadWillBegin-unmatched",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "metadata-only",
        streamSupported: false,
        streamError: "No matching Network requestId was available for byte streaming.",
        encodedDataLength: null,
        chromeDownloadId: null,
        localFilename: null,
        browserState: null,
        browserError: null
      });
      await addRawEvent(sessionId, source, "Recorder.downloadRequestUnmatched", {
        url: params?.url || "",
        suggestedFilename: params?.suggestedFilename || "",
        downloadGuid: params?.guid || null
      });
    }
    return;
  }

  if (method === "Page.downloadProgress") {
    await addRawEvent(sessionId, source, method, params || {});
    return;
  }

  if (!method.startsWith("Network.")) {
    if (/^(Page\.|Runtime\.|Log\.|Performance\.|Target\.)/.test(method)) {
      await addRawEvent(sessionId, source, method, params || {});
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    rememberRequest(sessionId, source, params);
  } else if (method === "Network.responseReceived") {
    rememberResponseUrl(sessionId, source, params);
  }

  let rawNetworkParams = params || {};
  if (method === "Network.requestWillBeSent" && params?.request) {
    const rawRequest = { ...params.request };
    const hadInlinePostData = typeof rawRequest.postData === "string" || Array.isArray(rawRequest.postDataEntries);
    if (hadInlinePostData) {
      delete rawRequest.postData;
      delete rawRequest.postDataEntries;
      rawNetworkParams = {
        ...params,
        request: rawRequest,
        requestBodyCapturedSeparately: true
      };
    }
  }

  // streamResourceContent adds base64 payload to Network.dataReceived. The payload
  // is persisted separately in downloadChunks to avoid duplicating large binaries
  // inside raw-events.json; the raw timeline still keeps the event and byte counts.
  if (method === "Network.dataReceived" && typeof params?.data === "string") {
    const key = downloadKey(sessionId, source, params.requestId);
    await dbAdd("downloadChunks", {
      sessionId,
      requestKey: key,
      sourceSessionId: source?.sessionId || null,
      requestId: params.requestId,
      capturedAt: new Date().toISOString(),
      data: params.data,
      buffered: false
    });
    const rawParams = { ...params, data: undefined, dataCapturedSeparately: true };
    delete rawParams.data;
    await addRawEvent(sessionId, source, method, rawParams);
  } else {
    await addRawEvent(sessionId, source, method, rawNetworkParams);
  }

  if (method === "Network.responseReceived" && params?.requestId && looksLikeDownloadResponse(params)) {
    const response = params.response || {};
    const disposition = headerValue(response.headers, "content-disposition");
    const options = await getSessionCaptureOptions(sessionId);
    await startDownloadStream(sessionId, source, params.requestId, {
      url: response.url || "",
      mimeType: response.mimeType || "",
      contentDisposition: disposition,
      suggestedFilename: filenameFromContentDisposition(disposition),
      reason: "response-headers",
      captureBytes: options.filesAndBlobs
    });
    return;
  }

  if (method === "Network.loadingFinished" && params?.requestId) {
    const options = await getSessionCaptureOptions(sessionId);
    const info = getRequestCaptureInfo(sessionId, source, params.requestId);
    const record = await dbGet("downloads", downloadKey(sessionId, source, params.requestId));
    if (record?.streamSupported) {
      await updateDownloadRecord(sessionId, source, params.requestId, {
        status: "network-complete",
        finishedAt: new Date().toISOString(),
        encodedDataLength: params.encodedDataLength ?? null
      });
      if (requestBodyPolicy(options, info)) await captureRequestPostData(sessionId, source, params.requestId);
    } else {
      if (record) {
        await updateDownloadRecord(sessionId, source, params.requestId, {
          status: record.status === "metadata-only" ? "metadata-only" : "network-complete",
          finishedAt: new Date().toISOString(),
          encodedDataLength: params.encodedDataLength ?? null
        });
      }
      await captureCompletedBodies(sessionId, source, params.requestId, options, info);
    }
    requestCaptureInfo.delete(requestCaptureKey(sessionId, source, params.requestId));
    return;
  }

  if (method === "Network.loadingFailed" && params?.requestId) {
    const record = await dbGet("downloads", downloadKey(sessionId, source, params.requestId));
    if (record) {
      await updateDownloadRecord(sessionId, source, params.requestId, {
        status: "network-ended",
        finishedAt: new Date().toISOString(),
        networkError: params.errorText || null,
        networkCanceled: Boolean(params.canceled)
      });
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  handleDebuggerEvent(source, method, params).catch(() => { });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  (async () => {
    if (!source?.tabId) {
      return;
    }
    rejectTracingCompletion(source.tabId, new Error(`Debugger отключён во время Chromium Tracing: ${reason}`));
    const sessionId = await getActiveSessionId(source.tabId);
    if (!sessionId) {
      return;
    }
    const session = await dbGet("sessions", sessionId);
    if (!session || session.status === "stopping" || session.status === "captured") {
      return;
    }

    await addRawEvent(sessionId, source, "Recorder.debuggerDetached", { reason });
    if (session.tracing?.requested && !["complete", "start-failed", "disabled"].includes(session.tracing.status)) {
      session.tracing.status = "interrupted";
      session.tracing.completedAt = new Date().toISOString();
      session.tracing.error = `Debugger detached: ${reason}`;
      await addWarning(sessionId, "tracing-interrupted", "Chromium Tracing прерван отключением debugger; trace может отсутствовать или быть неполным.", { reason });
    }
    await setActiveSession(source.tabId, null);
    session.status = "captured";
    session.stopReason = `debugger-detached:${reason}`;
    session.endTime = new Date().toISOString();
    await dbPut("sessions", session);
    await notifyTab(source.tabId, "exporting", "Debugger был отключён; сохраняется уже собранная часть сессии.");
    await requestExport(sessionId, source.tabId);
  })().catch(() => { });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const sessionId = await getActiveSessionId(tabId);
    if (!sessionId) {
      return;
    }
    const session = await dbGet("sessions", sessionId);
    rejectTracingCompletion(tabId, new Error("Вкладка закрыта во время Chromium Tracing."));
    await setActiveSession(tabId, null);
    if (!session) {
      return;
    }
    if (session.tracing?.requested && !["complete", "start-failed", "disabled"].includes(session.tracing.status)) {
      session.tracing.status = "interrupted";
      session.tracing.completedAt = new Date().toISOString();
      session.tracing.error = "Tab closed before tracing could be finalized.";
      await addWarning(sessionId, "tracing-interrupted", "Chromium Tracing прерван закрытием вкладки; trace может отсутствовать или быть неполным.", null);
    }
    session.status = "captured";
    session.stopReason = "tab-closed";
    session.endTime = new Date().toISOString();
    await dbPut("sessions", session);
    await requestExport(sessionId, tabId);
  })().catch(() => { });
});

async function getPendingDownloads() {
  const result = await storageGet(PENDING_DOWNLOADS_KEY);
  return result[PENDING_DOWNLOADS_KEY] || {};
}

async function setPendingDownloads(value) {
  await storageSet({ [PENDING_DOWNLOADS_KEY]: value });
}

chrome.downloads.onCreated.addListener((item) => {
  (async () => {
    // The archive download produced after Stop is not attributed to the captured
    // session because the session is already removed from ACTIVE_KEY at that point.
    const active = await getActiveSessions();
    const activeIds = new Set(Object.values(active));
    if (!activeIds.size) return;

    let recent = findRecentRequestAny(item.finalUrl || item.url || "") || findRecentRequestAny(item.url || "");
    let sessionId = recent?.sessionId || null;
    let tabId = recent?.source?.tabId ?? null;
    let source = recent?.source || null;
    let requestId = recent?.requestId || null;

    if (!sessionId || !activeIds.has(sessionId)) {
      const activeEntries = Object.entries(active);
      if (activeEntries.length === 1) {
        tabId = Number(activeEntries[0][0]);
        sessionId = activeEntries[0][1];
        source = { tabId };
      } else {
        return;
      }
    }

    const key = requestId
      ? downloadKey(sessionId, source, requestId)
      : `${sessionId}|browser-download|${item.id}`;
    const existing = await dbGet("downloads", key);
    const record = {
      ...(existing || {}),
      key,
      sessionId,
      sourceSessionId: existing?.sourceSessionId ?? (source?.sessionId || null),
      requestId: existing?.requestId ?? requestId,
      tabId,
      url: existing?.url || item.finalUrl || item.url || "",
      mimeType: existing?.mimeType || item.mime || "",
      contentDisposition: existing?.contentDisposition || "",
      suggestedFilename: existing?.suggestedFilename || "",
      startedAt: existing?.startedAt || item.startTime || new Date().toISOString(),
      finishedAt: existing?.finishedAt || null,
      status: existing?.status || "browser-download",
      streamSupported: Boolean(existing?.streamSupported),
      streamError: existing?.streamError || null,
      encodedDataLength: existing?.encodedDataLength ?? (item.totalBytes >= 0 ? item.totalBytes : null),
      chromeDownloadId: item.id,
      localFilename: item.filename || null,
      browserState: item.state || "in_progress",
      browserError: item.error || null,
      finalUrl: item.finalUrl || null,
      referrer: item.referrer || null,
      browserMime: item.mime || null,
      browserTotalBytes: item.totalBytes ?? null
    };
    await dbPut("downloads", record);
    await addRawEvent(sessionId, source || { tabId }, "Recorder.browserDownloadCreated", {
      chromeDownloadId: item.id,
      url: item.url || "",
      finalUrl: item.finalUrl || "",
      filename: item.filename || "",
      mime: item.mime || "",
      referrer: item.referrer || "",
      totalBytes: item.totalBytes ?? -1,
      requestId
    });
  })().catch(() => { });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.id || (!delta.state && !delta.error && !delta.filename)) {
    return;
  }

  (async () => {
    // First handle the recorder's own final ZIP download.
    const pending = await getPendingDownloads();
    const item = pending[String(delta.id)];
    if (item) {
      if (delta.state?.current === "complete") {
        delete pending[String(delta.id)];
        await setPendingDownloads(pending);
        const session = await dbGet("sessions", item.sessionId);
        if (session) {
          session.status = "exported";
          session.exportFile = item.filename;
          await dbPut("sessions", session);
        }
        await notifyTab(item.tabId, "saved", item.filename);
        chrome.runtime.sendMessage({ type: "offscreen:revoke", target: "offscreen", token: item.token });
      } else if (delta.error) {
        delete pending[String(delta.id)];
        await setPendingDownloads(pending);
        await notifyTab(item.tabId, "error", `Ошибка сохранения ZIP: ${delta.error.current || "unknown"}`);
        chrome.runtime.sendMessage({ type: "offscreen:revoke", target: "offscreen", token: item.token });
      }
      return;
    }

    // Then update downloads that happened while the recorded browser-tab session was active.
    const record = await dbGetByIndex("downloads", "chromeDownloadId", delta.id);
    if (!record) return;

    if (delta.filename?.current) record.localFilename = delta.filename.current;
    if (delta.state?.current) record.browserState = delta.state.current;
    if (delta.error?.current) record.browserError = delta.error.current;
    if (delta.state?.current === "complete" || delta.error?.current) {
      record.finishedAt = record.finishedAt || new Date().toISOString();
    }
    await dbPut("downloads", record);
    await addRawEvent(record.sessionId, { tabId: record.tabId, sessionId: record.sourceSessionId || undefined }, "Recorder.browserDownloadChanged", {
      chromeDownloadId: delta.id,
      state: delta.state?.current || null,
      error: delta.error?.current || null,
      filename: delta.filename?.current || null
    });
  })().catch(() => { });
});

chrome.action.onClicked.addListener((tab) => {
  (async () => {
    const tabId = tab?.id;
    if (!Number.isInteger(tabId)) return;

    const sessionId = await getActiveSessionId(tabId);
    if (sessionId) {
      await stopCapture(tabId, "toolbar");
      return;
    }

    const captureOptions = await getStoredCaptureOptions();
    try {
      await startCapture(tabId, tab?.url || "", captureOptions);
    } catch (error) {
      const detail = error?.message || String(error);
      await notifyTab(tabId, "error", detail);
      setTimeout(() => { updateActionState(tabId, "idle").catch(() => { }); }, 3500);
    }
  })().catch(() => { });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.target === "offscreen") {
    return false;
  }

  (async () => {
    if (message.type === "capture:getState") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "Не удалось определить вкладку." });
        return;
      }
      const sessionId = await getActiveSessionId(tabId);
      sendResponse({ ok: true, state: sessionId ? "recording" : "idle", sessionId });
      return;
    }

    if (message.type === "capture:toggle") {
      const tabId = sender.tab?.id;
      const url = sender.tab?.url || sender.url || "";
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false, error: "Не удалось определить вкладку." });
        return;
      }
      const sessionId = await getActiveSessionId(tabId);
      const result = sessionId
        ? await stopCapture(tabId, "user")
        : await startCapture(tabId, url, normalizeCaptureOptions(message.captureOptions || {}));
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === "capture:domMutation") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) { sendResponse({ ok: false }); return; }
      const sessionId = await getActiveSessionId(tabId);
      if (!sessionId) { sendResponse({ ok: true, ignored: true }); return; }
      await addRawEvent(sessionId, { tabId }, "Recorder.domMutation", message.batch || {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "capture:userEvent") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ ok: false });
        return;
      }
      const sessionId = await getActiveSessionId(tabId);
      if (!sessionId) {
        sendResponse({ ok: true, ignored: true });
        return;
      }
      const event = message.event || {};
      await addRawEvent(sessionId, { tabId }, "Recorder.userAction", event);
      const objectUrl = event?.download?.href || "";
      if (objectUrl.startsWith("blob:")) {
        const blob = await dbGetByIndex("pageBlobs", "objectUrl", objectUrl);
        if (blob) {
          blob.suggestedFilename = event.download.filename || blob.suggestedFilename || null;
          blob.downloadClickedAt = event.capturedAt || new Date().toISOString();
          await dbPut("pageBlobs", blob);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "offscreen:ready") {
      const { sessionId, tabId, blobUrl, filename, token } = message;

      let pageSave = null;
      try {
        pageSave = await requestTab(tabId, {
          type: "capture:saveZip",
          blobUrl,
          filename
        });
      } catch (_) {
        pageSave = null;
      }

      if (pageSave?.ok) {
        const session = await dbGet("sessions", sessionId);
        if (session) {
          session.status = "exported";
          session.exportFile = filename;
          session.exportFolder = pageSave.folderName || null;
          await dbPut("sessions", session);
        }
        const detail = pageSave.folderName ? `${pageSave.folderName}\\${filename}` : filename;
        await notifyTab(tabId, "saved", detail);
        chrome.runtime.sendMessage({ type: "offscreen:revoke", target: "offscreen", token });
        return;
      }

      if (pageSave?.configured) {
        await notifyTab(tabId, "error", pageSave.error || "Не удалось сохранить ZIP в выбранную папку.");
        chrome.runtime.sendMessage({ type: "offscreen:revoke", target: "offscreen", token });
        return;
      }

      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download({
          url: blobUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        }, (id) => {
          if (chrome.runtime.lastError || !Number.isInteger(id)) {
            reject(chromeError("Не удалось начать сохранение ZIP"));
            return;
          }
          resolve(id);
        });
      });
      const pending = await getPendingDownloads();
      pending[String(downloadId)] = { sessionId, tabId, filename, token };
      await setPendingDownloads(pending);
      return;
    }

    if (message.type === "offscreen:error") {
      await notifyTab(message.tabId, "error", message.error || "Не удалось сформировать ZIP.");
      return;
    }
  })().catch((error) => {
    try {
      sendResponse({ ok: false, error: error?.message || String(error) });
    } catch (_) { }
  });

  return true;
});
