(() => {
  "use strict";

  const CONTROLS_ID = "einv-network-recorder-controls";
  const SETTINGS_OVERLAY_ID = "einv-network-recorder-settings-overlay";
  const POSITION_STORAGE_KEY = "einvTestButtonPosition";
  const SETTINGS_DB = "einv-network-recorder-page-settings";
  const SETTINGS_DB_VERSION = 1;
  const SETTINGS_STORE = "settings";
  const DIRECTORY_KEY = "saveDirectory";
  const TRACING_KEY = "chromiumTracingEnabled";
  const API_BODIES_KEY = "captureApiBodiesEnabled";
  const PAGE_RESOURCES_KEY = "capturePageResourcesEnabled";
  const ALL_RESOURCE_BODIES_KEY = "captureAllResourceBodiesEnabled";
  const FILES_BLOBS_KEY = "captureFilesAndBlobsEnabled";
  const DEEP_DIAGNOSTICS_KEY = "captureDeepDiagnosticsEnabled";
  const BOOLEAN_SETTING_DEFAULTS = Object.freeze({
    [TRACING_KEY]: false,
    [API_BODIES_KEY]: true,
    [PAGE_RESOURCES_KEY]: true,
    [ALL_RESOURCE_BODIES_KEY]: false,
    [FILES_BLOBS_KEY]: false,
    [DEEP_DIAGNOSTICS_KEY]: false
  });
  const GLOBAL_BOOLEAN_SETTINGS = new Set(Object.keys(BOOLEAN_SETTING_DEFAULTS));
  const PAGE_MARGIN = 8;
  const DRAG_THRESHOLD = 4;

  if (document.getElementById(CONTROLS_ID)) {
    return;
  }

  const controls = document.createElement("div");
  controls.id = CONTROLS_ID;
  Object.assign(controls.style, {
    position: "fixed",
    left: "24px",
    top: "24px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "stretch",
    gap: "6px",
    fontFamily: "Arial, sans-serif",
    userSelect: "none",
    touchAction: "none"
  });

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Запись";
  button.title = "Нажмите, чтобы начать запись сетевой активности. Кнопку можно перетаскивать.";
  Object.assign(button.style, {
    minWidth: "92px",
    padding: "10px 16px",
    border: "1px solid rgba(0, 0, 0, 0.22)",
    borderRadius: "10px",
    background: "#ffffff",
    color: "#111111",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.2",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.22)",
    cursor: "grab",
    transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease"
  });

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.textContent = "⚙";
  settingsButton.title = "Настройки";
  settingsButton.setAttribute("aria-label", "Настройки Network Recorder");
  Object.assign(settingsButton.style, {
    width: "42px",
    minWidth: "42px",
    padding: "0",
    border: "1px solid rgba(0, 0, 0, 0.22)",
    borderRadius: "10px",
    background: "#ffffff",
    color: "#333333",
    fontFamily: "Arial, sans-serif",
    fontSize: "19px",
    lineHeight: "1",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.22)",
    cursor: "pointer"
  });

  controls.append(button, settingsButton);
  document.documentElement.appendChild(controls);

  let currentState = "idle";
  let flashTimer = null;
  let drag = null;
  let suppressNextClick = false;
  let settingsOverlay = null;
  let mutationObserver = null;
  let mutationTimer = null;
  let mutationBatch = null;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  const sendMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });

  const getGlobalSetting = (key) => new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result?.[key] ?? null);
    });
  });

  const setGlobalSetting = (key, value) => new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });

  const openSettingsDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(SETTINGS_DB, SETTINGS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Не удалось открыть настройки."));
  });

  const getSetting = async (key) => {
    if (GLOBAL_BOOLEAN_SETTINGS.has(key)) {
      const value = await getGlobalSetting(key);
      return value == null ? BOOLEAN_SETTING_DEFAULTS[key] : Boolean(value);
    }
    const db = await openSettingsDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, "readonly");
        const request = tx.objectStore(SETTINGS_STORE).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Не удалось прочитать настройку."));
      });
    } finally {
      db.close();
    }
  };

  const setSetting = async (key, value) => {
    if (GLOBAL_BOOLEAN_SETTINGS.has(key)) {
      await setGlobalSetting(key, Boolean(value));
      return;
    }
    const db = await openSettingsDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, "readwrite");
        tx.objectStore(SETTINGS_STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Не удалось сохранить настройку."));
        tx.onabort = () => reject(tx.error || new Error("Не удалось сохранить настройку."));
      });
    } finally {
      db.close();
    }
  };

  const deleteSetting = async (key) => {
    if (GLOBAL_BOOLEAN_SETTINGS.has(key)) {
      await setGlobalSetting(key, BOOLEAN_SETTING_DEFAULTS[key]);
      return;
    }
    const db = await openSettingsDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, "readwrite");
        tx.objectStore(SETTINGS_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Не удалось удалить настройку."));
        tx.onabort = () => reject(tx.error || new Error("Не удалось удалить настройку."));
      });
    } finally {
      db.close();
    }
  };

  const getDirectoryPermission = async (handle) => {
    if (!handle) {
      return "missing";
    }
    if (typeof handle.queryPermission !== "function") {
      return "granted";
    }
    try {
      return await handle.queryPermission({ mode: "readwrite" });
    } catch (_) {
      return "denied";
    }
  };

  const saveZipToConfiguredDirectory = async (blobUrl, filename) => {
    const handle = await getSetting(DIRECTORY_KEY);
    if (!handle) {
      return { ok: false, configured: false, reason: "not-configured" };
    }

    const permission = await getDirectoryPermission(handle);
    if (permission !== "granted") {
      return {
        ok: false,
        configured: true,
        reason: "permission-not-granted",
        error: "Нет доступа к выбранной папке. Откройте настройки и выберите её повторно.",
        folderName: handle.name || ""
      };
    }

    let writable = null;
    let reader = null;
    try {
      // Не загружаем весь ZIP вторым Blob в память страницы. Читаем Blob URL
      // потоком и последовательно пишем небольшими чанками в выбранный файл.
      // Это заметно снижает пиковое потребление памяти и нагрузку на реализацию
      // File System Access в Chromium/Yandex при больших research-архивах.
      const response = await fetch(blobUrl);
      if (!response.ok) {
        throw new Error(`Не удалось получить ZIP: HTTP ${response.status}`);
      }

      const fileHandle = await handle.getFileHandle(filename, { create: true });
      writable = await fileHandle.createWritable({ keepExistingData: false });

      if (response.body && typeof response.body.getReader === "function") {
        reader = response.body.getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          if (part.value && part.value.byteLength > 0) {
            await writable.write(part.value);
          }
        }
      } else {
        // Резерв для старых Chromium-сборок без ReadableStream у fetch().
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const chunkSize = 256 * 1024;
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          await writable.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
        }
      }

      await writable.close();
      writable = null;
      return { ok: true, configured: true, folderName: handle.name || "" };
    } catch (error) {
      if (reader) {
        try { await reader.cancel(); } catch (_) { }
      }
      if (writable) {
        try { await writable.abort(); } catch (_) { }
      }
      return {
        ok: false,
        configured: true,
        reason: "write-failed",
        error: `Не удалось сохранить ZIP в выбранную папку: ${error?.message || String(error)}`,
        folderName: handle.name || ""
      };
    }
  };

  const applyPosition = (left, top) => {
    const panelHeight = settingsOverlay?.offsetHeight || 0;
    const extraHeight = panelHeight > 0 ? panelHeight + 8 : 0;
    const maxLeft = window.innerWidth - controls.offsetWidth - PAGE_MARGIN;
    const maxTop = window.innerHeight - controls.offsetHeight - extraHeight - PAGE_MARGIN;
    controls.style.left = `${clamp(left, PAGE_MARGIN, maxLeft)}px`;
    controls.style.top = `${clamp(top, PAGE_MARGIN, maxTop)}px`;
  };

  const savePosition = () => {
    const rect = controls.getBoundingClientRect();
    chrome.storage.local.set({
      [POSITION_STORAGE_KEY]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }
    });
  };

  chrome.storage.local.get(POSITION_STORAGE_KEY, (result) => {
    const saved = result?.[POSITION_STORAGE_KEY];
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyPosition(saved.left, saved.top);
    }
  });

  const truncateText = (value, limit = 2000) => {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };

  const describeActionTarget = (node) => {
    if (!(node instanceof Element)) {
      return { tag: null };
    }
    const target = node.closest("a,button,input,select,textarea,form,[role],[data-testid],[id]") || node;
    const tag = target.tagName?.toLowerCase() || null;
    const result = {
      tag,
      id: target.id || null,
      name: target.getAttribute?.("name") || null,
      role: target.getAttribute?.("role") || null,
      type: target.getAttribute?.("type") || null,
      className: truncateText(typeof target.className === "string" ? target.className : "", 500) || null,
      text: truncateText(target.innerText || target.textContent || "", 500) || null
    };
    if (target instanceof HTMLInputElement) {
      if ((target.type || "").toLowerCase() === "password") {
        result.value = "[password]";
      } else if (target.type === "checkbox" || target.type === "radio") {
        result.checked = target.checked;
        result.value = truncateText(target.value, 2000);
      } else {
        result.value = truncateText(target.value, 2000);
      }
    } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      result.value = truncateText(target.value, 2000);
    }
    if (target instanceof HTMLAnchorElement) {
      result.href = target.href || null;
      result.download = target.download || null;
      result.target = target.target || null;
    }
    if (target instanceof HTMLFormElement) {
      result.action = target.action || null;
      result.method = target.method || null;
    }
    return result;
  };

  const emitUserEvent = (kind, domEvent = null, extra = null) => {
    if (currentState !== "recording") return;
    const path = typeof domEvent?.composedPath === "function" ? domEvent.composedPath() : [];
    if (path.includes(controls)) return;
    const target = domEvent?.target instanceof Element ? domEvent.target : null;
    const targetInfo = describeActionTarget(target);
    const anchor = target?.closest?.("a[href]") || null;
    const event = {
      kind,
      capturedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      target: targetInfo,
      pointer: domEvent && "clientX" in domEvent ? { x: domEvent.clientX, y: domEvent.clientY, button: domEvent.button ?? null } : null,
      key: domEvent instanceof KeyboardEvent ? domEvent.key : null,
      download: anchor && anchor.download ? { href: anchor.href || "", filename: anchor.download || "" } : null,
      extra: extra || null
    };
    chrome.runtime.sendMessage({ type: "capture:userEvent", event }, () => { void chrome.runtime.lastError; });
  };

  const flushMutationBatch = () => {
    if (!mutationBatch) return;
    const batch = mutationBatch;
    mutationBatch = null;
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    if (batch.added || batch.removed || batch.attributes || batch.characterData) {
      chrome.runtime.sendMessage({ type: "capture:domMutation", batch }, () => { void chrome.runtime.lastError; });
    }
  };

  const stopMutationCapture = () => {
    flushMutationBatch();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  };

  const startMutationCapture = () => {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Node ? record.target : null;
        if (target && (target === controls || controls.contains(target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement))) continue;
        if (!mutationBatch) {
          mutationBatch = {
            capturedAt: new Date().toISOString(),
            url: location.href,
            added: 0,
            removed: 0,
            attributes: 0,
            characterData: 0,
            attributeNames: {},
            samples: []
          };
        }
        if (record.type === "childList") {
          mutationBatch.added += record.addedNodes?.length || 0;
          mutationBatch.removed += record.removedNodes?.length || 0;
        } else if (record.type === "attributes") {
          mutationBatch.attributes += 1;
          const name = record.attributeName || "unknown";
          mutationBatch.attributeNames[name] = (mutationBatch.attributeNames[name] || 0) + 1;
        } else if (record.type === "characterData") {
          mutationBatch.characterData += 1;
        }
        if (mutationBatch.samples.length < 10 && record.target instanceof Element) {
          mutationBatch.samples.push({ tag: record.target.tagName?.toLowerCase() || null, id: record.target.id || null, className: truncateText(typeof record.target.className === "string" ? record.target.className : "", 200) || null });
        }
      }
      if (mutationBatch && !mutationTimer) mutationTimer = setTimeout(flushMutationBatch, 500);
    });
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };

  const setState = (state, detail = "") => {
    currentState = state;
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }

    settingsButton.disabled = state === "exporting";
    settingsButton.style.opacity = settingsButton.disabled ? "0.55" : "1";

    if (state === "recording") startMutationCapture();
    else stopMutationCapture();

    if (state === "recording") {
      button.textContent = "Стоп";
      button.style.background = "#d93025";
      button.style.color = "#ffffff";
      button.style.borderColor = "#b3261e";
      button.title = "Идёт запись сетевой активности. Нажмите, чтобы остановить запись и сохранить ZIP.";
      button.disabled = false;
      return;
    }

    if (state === "exporting") {
      button.textContent = "ZIP…";
      button.style.background = "#e8eaed";
      button.style.color = "#5f6368";
      button.style.borderColor = "#c4c7c5";
      button.title = "Формируется ZIP-архив.";
      button.disabled = true;
      return;
    }

    if (state === "saved") {
      button.textContent = "Сохранено";
      button.style.background = "#188038";
      button.style.color = "#ffffff";
      button.style.borderColor = "#137333";
      button.title = detail || "ZIP-архив сохранён.";
      button.disabled = true;
      flashTimer = setTimeout(() => setState("idle"), 1800);
      return;
    }

    if (state === "error") {
      button.textContent = "Ошибка";
      button.style.background = "#fce8e6";
      button.style.color = "#b3261e";
      button.style.borderColor = "#d93025";
      button.title = detail || "Ошибка записи сетевой активности.";
      button.disabled = false;
      flashTimer = setTimeout(() => setState("idle"), 3500);
      return;
    }

    button.textContent = "Запись";
    button.style.background = "#ffffff";
    button.style.color = "#111111";
    button.style.borderColor = "rgba(0, 0, 0, 0.22)";
    button.title = "Нажмите, чтобы начать запись сетевой активности. Кнопку можно перетаскивать.";
    button.disabled = false;
  };

  const closeSettings = () => {
    if (!settingsOverlay) {
      return;
    }

    const previousFocus = settingsOverlay.__previousFocus;
    const outsideHandler = settingsOverlay.__outsideHandler;
    if (outsideHandler) {
      document.removeEventListener("pointerdown", outsideHandler, true);
    }

    settingsOverlay.remove();
    settingsOverlay = null;

    if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
      try { previousFocus.focus(); } catch (_) { }
    }
  };

  const openSettings = async () => {
    if (settingsOverlay) {
      closeSettings();
      return;
    }

    const host = document.createElement("div");
    host.id = SETTINGS_OVERLAY_ID;
    host.__previousFocus = document.activeElement;
    Object.assign(host.style, {
      all: "initial",
      position: "absolute",
      top: "calc(100% + 8px)",
      right: "0",
      zIndex: "2147483647",
      display: "block",
      width: "390px",
      touchAction: "auto",
      userSelect: "auto"
    });

    const shadow = host.attachShadow({ mode: "open" });
    const extensionVersion = chrome.runtime.getManifest().version;

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        color: #202124;
      }

      *, *::before, *::after { box-sizing: border-box; }

      .panel {
        width: 390px;
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        padding: 12px 14px 12px;
        border: 1px solid #d9d9d9;
        border-radius: 12px;
        background: #ffffff;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      }

      .version {
        margin: 0 0 3px 0;
        color: #777777;
        font: 400 11px/15px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      }

      .title {
        margin: 0 0 12px 0;
        color: #202124;
        font: 650 16px/21px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      }

      .setting-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
      }

      .setting-label {
        min-width: 0;
        color: #303134;
        font: 600 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      }

      .button {
        appearance: none;
        min-height: 32px;
        margin: 0;
        padding: 6px 11px;
        border: 1px solid #c9c9c9;
        border-radius: 8px;
        background: #ffffff;
        color: #202124;
        font: 600 12.5px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
        white-space: nowrap;
      }

      .button:hover { background: #f7f7f7; border-color: #b9b9b9; }
      .button:active { background: #eeeeee; }
      .button:disabled { opacity: 0.55; cursor: default; }
      .button:focus-visible {
        outline: 2px solid #1a73e8;
        outline-offset: 2px;
      }

      .folder-field {
        width: 100%;
        min-height: 31px;
        margin-top: 8px;
        padding: 6px 9px;
        display: flex;
        align-items: center;
        overflow: hidden;
        border: 1px solid #e0e0e0;
        border-radius: 7px;
        background: #f7f7f7;
        color: #3c4043;
        font: 400 12px/17px "Segoe UI", Arial, sans-serif;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .folder-field.empty { color: #777777; }

      .status {
        display: none;
        margin-top: 6px;
        color: #b3261e;
        font: 400 11.5px/16px "Segoe UI", Arial, sans-serif;
      }

      .trace-row {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #eeeeee;
      }

      .trace-checkbox {
        width: 16px;
        height: 16px;
        margin: 2px 0 0 0;
        flex: 0 0 auto;
        accent-color: #1a73e8;
        cursor: pointer;
      }

      .trace-checkbox:disabled { cursor: default; opacity: 0.55; }

      .trace-copy {
        min-width: 0;
        cursor: pointer;
      }

      .trace-title {
        color: #303134;
        font: 600 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      }

      .trace-note {
        margin-top: 2px;
        color: #666666;
        font: 400 11.5px/15px "Segoe UI", Arial, sans-serif;
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        margin-top: 10px;
      }

      .ok-button { min-width: 62px; }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "einv-recorder-settings-title");

    const version = document.createElement("div");
    version.className = "version";
    version.textContent = `Network Recorder · v${extensionVersion}`;

    const title = document.createElement("div");
    title.id = "einv-recorder-settings-title";
    title.className = "title";
    title.textContent = "Настройки";

    const settingRow = document.createElement("div");
    settingRow.className = "setting-row";

    const label = document.createElement("div");
    label.className = "setting-label";
    label.textContent = "Папка для сохранения ZIP";

    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "button";
    choose.textContent = "Выбрать папку…";

    const folder = document.createElement("div");
    folder.className = "folder-field empty";
    folder.setAttribute("role", "status");
    folder.setAttribute("aria-live", "polite");

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "alert");

    const toggleSpecs = [
      {
        key: API_BODIES_KEY,
        title: "Тела API (XHR / Fetch)",
        note: "Включено по умолчанию. Сохраняет request/response bodies API-запросов."
      },
      {
        key: PAGE_RESOURCES_KEY,
        title: "Текстовые ресурсы страницы",
        note: "HTML, JavaScript, CSS и другие текстовые ресурсы. Картинки, видео и шрифты сюда не входят."
      },
      {
        key: ALL_RESOURCE_BODIES_KEY,
        title: "Все тела ресурсов",
        note: "Добавляет изображения, шрифты и прочие бинарные response bodies. Может резко увеличить ZIP."
      },
      {
        key: FILES_BLOBS_KEY,
        title: "Файлы и blob:-объекты",
        note: "Сохраняет байты скачиваемых файлов и blob:-объектов. Метаданные загрузок пишутся и без этой опции."
      },
      {
        key: DEEP_DIAGNOSTICS_KEY,
        title: "Глубокая диагностика страницы",
        note: "IndexedDB, Cache Storage, MHTML и DOMSnapshot. Тяжёлый режим; по умолчанию выключен."
      },
      {
        key: TRACING_KEY,
        title: "Chromium Tracing",
        note: "Полный trace Chromium. Самый тяжёлый режим; по умолчанию выключен."
      }
    ];

    const toggleControls = new Map();
    const toggleRows = toggleSpecs.map((spec) => {
      const row = document.createElement("label");
      row.className = "trace-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "trace-checkbox";
      checkbox.setAttribute("aria-label", spec.title);

      const copy = document.createElement("div");
      copy.className = "trace-copy";

      const rowTitle = document.createElement("div");
      rowTitle.className = "trace-title";
      rowTitle.textContent = spec.title;

      const note = document.createElement("div");
      note.className = "trace-note";
      note.textContent = spec.note;

      copy.append(rowTitle, note);
      row.append(checkbox, copy);
      toggleControls.set(spec.key, { checkbox, note, spec });
      return row;
    });

    const footer = document.createElement("div");
    footer.className = "footer";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "button ok-button";
    ok.textContent = "ОК";

    const setSettingsError = (text) => {
      status.textContent = text || "";
      status.style.display = text ? "block" : "none";
    };

    const refreshSettings = async () => {
      const locked = currentState === "recording" || currentState === "exporting";
      for (const [key, control] of toggleControls) {
        control.checkbox.checked = Boolean(await getSetting(key));
        control.checkbox.disabled = locked;
        control.note.textContent = currentState === "recording"
          ? "Текущая запись уже запущена; изменение применяется со следующей сессии."
          : control.spec.note;
      }

      const handle = await getSetting(DIRECTORY_KEY);
      if (!handle) {
        folder.textContent = "Папка не выбрана";
        folder.title = "";
        folder.classList.add("empty");
        setSettingsError("");
        return;
      }

      const visibleName = handle.name || "Выбранная папка";
      folder.textContent = `…\\${visibleName}`;
      folder.title = `Выбрана папка «${visibleName}». Полный системный путь File System Access API не раскрывает.`;
      folder.classList.remove("empty");

      const permission = await getDirectoryPermission(handle);
      if (permission === "granted") {
        setSettingsError("");
      } else {
        setSettingsError("Нет доступа к папке. Выберите её повторно.");
      }
    };

    for (const [key, control] of toggleControls) {
      control.checkbox.addEventListener("change", async () => {
        const previous = !control.checkbox.checked;
        control.checkbox.disabled = true;
        setSettingsError("");
        try {
          await setSetting(key, control.checkbox.checked);
        } catch (error) {
          control.checkbox.checked = previous;
          setSettingsError(error?.message || String(error));
        } finally {
          control.checkbox.disabled = currentState === "recording" || currentState === "exporting";
        }
      });
    }

    choose.addEventListener("click", async () => {
      setSettingsError("");
      if (typeof window.showDirectoryPicker !== "function") {
        setSettingsError("Эта версия браузера не поддерживает выбор папки.");
        return;
      }

      choose.disabled = true;
      try {
        const existing = await getSetting(DIRECTORY_KEY);
        const options = { id: "einv-network-recorder-zip", mode: "readwrite" };
        if (existing) {
          options.startIn = existing;
        }
        const handle = await window.showDirectoryPicker(options);
        await setSetting(DIRECTORY_KEY, handle);
        await refreshSettings();
      } catch (error) {
        if (error?.name !== "AbortError") {
          setSettingsError(error?.message || String(error));
        }
      } finally {
        choose.disabled = false;
      }
    });

    ok.addEventListener("click", closeSettings);

    panel.append(version, title, settingRow, folder, status, ...toggleRows, footer);
    settingRow.append(label, choose);
    footer.append(ok);
    shadow.append(style, panel);
    controls.appendChild(host);
    settingsOverlay = host;

    // Если кнопки находятся у края экрана, панель остаётся прикреплённой к ним,
    // но выбирает сторону выравнивания так, чтобы не выходить за границы viewport.
    const controlsRect = controls.getBoundingClientRect();
    if (controlsRect.left + 390 <= window.innerWidth - PAGE_MARGIN) {
      host.style.left = "0";
      host.style.right = "auto";
    } else {
      host.style.left = "auto";
      host.style.right = "0";
    }

    const rectAfterOpen = controls.getBoundingClientRect();
    applyPosition(rectAfterOpen.left, rectAfterOpen.top);

    const outsideHandler = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(host) || path.includes(settingsButton)) {
        return;
      }
      closeSettings();
    };
    host.__outsideHandler = outsideHandler;
    setTimeout(() => {
      if (settingsOverlay === host) {
        document.addEventListener("pointerdown", outsideHandler, true);
      }
    }, 0);

    try {
      await refreshSettings();
    } catch (error) {
      folder.textContent = "Не удалось прочитать настройки";
      folder.classList.add("empty");
      setSettingsError(error?.message || String(error));
    }

    try { choose.focus({ preventScroll: true }); } catch (_) { try { choose.focus(); } catch (_) { } }
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) {
      return;
    }

    const rect = controls.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false
    };

    suppressNextClick = false;
    button.style.cursor = "grabbing";
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  button.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;

    if (!drag.moved && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD) {
      drag.moved = true;
    }

    if (drag.moved) {
      applyPosition(drag.startLeft + deltaX, drag.startTop + deltaY);
    }
  });

  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const wasMoved = drag.moved;
    drag = null;
    button.style.cursor = "grab";

    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

    if (wasMoved) {
      suppressNextClick = true;
      savePosition();
    }
  };

  button.addEventListener("pointerup", finishDrag);
  button.addEventListener("pointercancel", finishDrag);

  button.addEventListener("click", async (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (currentState === "exporting" || currentState === "saved") {
      return;
    }

    button.disabled = true;
    try {
      const captureOptions = currentState === "recording" ? null : {
        tracingEnabled: Boolean(await getSetting(TRACING_KEY)),
        apiBodies: Boolean(await getSetting(API_BODIES_KEY)),
        pageResources: Boolean(await getSetting(PAGE_RESOURCES_KEY)),
        allResourceBodies: Boolean(await getSetting(ALL_RESOURCE_BODIES_KEY)),
        filesAndBlobs: Boolean(await getSetting(FILES_BLOBS_KEY)),
        deepDiagnostics: Boolean(await getSetting(DEEP_DIAGNOSTICS_KEY))
      };
      const response = await sendMessage({ type: "capture:toggle", captureOptions });
      if (!response?.ok) {
        throw new Error(response?.error || "Не удалось изменить состояние записи.");
      }
      setState(response.state || "idle", response.detail || "");
    } catch (error) {
      setState("error", error?.message || String(error));
    }
  });

  settingsButton.addEventListener("click", () => {
    if (!settingsButton.disabled) {
      openSettings().catch((error) => setState("error", error?.message || String(error)));
    }
  });

  document.addEventListener("click", (event) => emitUserEvent("click", event), true);
  document.addEventListener("change", (event) => emitUserEvent("change", event), true);
  document.addEventListener("submit", (event) => emitUserEvent("submit", event), true);
  window.addEventListener("hashchange", (event) => emitUserEvent("hashchange", null, { oldURL: event.oldURL, newURL: event.newURL }), true);
  window.addEventListener("popstate", () => emitUserEvent("popstate", null, { href: location.href }), true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "capture:state") {
      setState(message.state || "idle", message.detail || "");
      return false;
    }

    if (message?.type === "capture:saveZip") {
      saveZipToConfiguredDirectory(message.blobUrl, message.filename)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          ok: false,
          configured: true,
          reason: "write-failed",
          error: error?.message || String(error)
        }));
      return true;
    }

    return false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOverlay) {
      closeSettings();
    }
  }, true);

  window.addEventListener("resize", () => {
    const rect = controls.getBoundingClientRect();
    applyPosition(rect.left, rect.top);
  });

  sendMessage({ type: "capture:getState" })
    .then((response) => {
      if (response?.ok) {
        setState(response.state || "idle", response.detail || "");
      }
    })
    .catch(() => setState("idle"));
})();
