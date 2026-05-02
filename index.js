/**
 * File Editor
 *
 * Turns Codex's right-panel read-only file view into an editable local text
 * editor. Renderer code owns the DOM overlay; main-process code owns file IO.
 */

const DEFAULT_AUTOSAVE_DELAY_MS = 1200;
const MIN_AUTOSAVE_DELAY_MS = 250;
const MAX_AUTOSAVE_DELAY_MS = 10000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HIGHLIGHT_MAX_CHARS = 500000;
const STYLE_ID = "codexpp-file-editor-style";

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    if (api.process === "main") {
      startMain(api);
      return;
    }

    globalThis.__codexppFileEditorRendererState?.disposeRenderer?.();

    const state = {
      api,
      active: null,
      loading: null,
      observer: null,
      pageHandle: null,
      scanInterval: null,
      scanning: false,
      disposed: false,
      disposeRenderer: null,
    };
    state.disposeRenderer = () => disposeRendererState(state);
    globalThis.__codexppFileEditorRendererState = state;
    this._state = state;

    installStyles();
    registerSettingsPage(state);
    startRightPanelWatcher(state);
  },

  stop() {
    const state = this._state;
    if (!state) return;
    disposeRendererState(state);
    if (globalThis.__codexppFileEditorRendererState === state) {
      delete globalThis.__codexppFileEditorRendererState;
    }
  },
};

function disposeRendererState(state) {
  if (state.disposed) return;
  state.disposed = true;
  state.observer?.disconnect();
  state.observer = null;
  if (state.scanInterval) {
    window.clearInterval(state.scanInterval);
    state.scanInterval = null;
  }
  if (state._scheduleScan) {
    document.removeEventListener("click", state._scheduleScan, true);
    window.removeEventListener("resize", state._scheduleScan);
  }
  state.active?.dispose();
  state.active = null;
  state.pageHandle?.unregister();
  state.pageHandle = null;
  removeStylesIfUnused();
}

// ---------------------------------------------------------------- main side

function startMain(api) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  const registry =
    (globalThis.__codexppFileEditorIpcRegistry ||= {
      registered: false,
      handlers: Object.create(null),
    });

  registry.handlers["read-file"] = async (filePath) => {
    try {
      const normalized = normalizeLocalFilePath(path, filePath);
      const stat = await fs.promises.stat(normalized);
      if (!stat.isFile()) {
        return failure("not_file", "The selected path is not a file.");
      }
      if (stat.size > MAX_FILE_BYTES) {
        return failure(
          "too_large",
          `File is larger than ${formatBytes(MAX_FILE_BYTES)}.`,
        );
      }

      const buffer = await fs.promises.readFile(normalized);
      if (looksBinary(buffer)) {
        return failure("binary", "Binary files are not editable here.");
      }

      return {
        ok: true,
        path: normalized,
        content: buffer.toString("utf8"),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["write-file"] = async (payload) => {
    try {
      const normalized = normalizeLocalFilePath(path, payload?.path);
      const content =
        typeof payload?.content === "string" ? payload.content : "";
      const expectedMtimeMs = Number(payload?.expectedMtimeMs);
      const force = payload?.force === true;

      let stat;
      try {
        stat = await fs.promises.stat(normalized);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      if (stat && !stat.isFile()) {
        return failure("not_file", "The selected path is not a file.");
      }
      if (
        stat &&
        !force &&
        Number.isFinite(expectedMtimeMs) &&
        Math.abs(stat.mtimeMs - expectedMtimeMs) > 5
      ) {
        return {
          ok: false,
          code: "conflict",
          message: "File changed on disk after it was opened.",
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      }

      const dir = path.dirname(normalized);
      const base = path.basename(normalized);
      const tmp = path.join(
        dir,
        `.${base}.codexpp-${process.pid}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}.tmp`,
      );

      try {
        await fs.promises.writeFile(tmp, content, "utf8");
        await fs.promises.rename(tmp, normalized);
      } catch (error) {
        try {
          await fs.promises.rm(tmp, { force: true });
        } catch {
          // Ignore temp cleanup failures.
        }
        throw error;
      }

      const nextStat = await fs.promises.stat(normalized);
      return {
        ok: true,
        path: normalized,
        mtimeMs: nextStat.mtimeMs,
        size: nextStat.size,
      };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["stat-file"] = async (filePath) => {
    try {
      const normalized = normalizeLocalFilePath(path, filePath);
      const stat = await fs.promises.stat(normalized);
      return {
        ok: true,
        path: normalized,
        isFile: stat.isFile(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch (error) {
      return errorFailure(error);
    }
  };

  if (!registry.registered) {
    for (const channel of ["read-file", "write-file", "stat-file"]) {
      api.ipc.handle(channel, (...args) =>
        registry.handlers[channel](...args),
      );
    }
    registry.registered = true;
  }

  api.log.info("file editor main handlers ready", { tmp: os.tmpdir() });
}

function normalizeLocalFilePath(path, value) {
  if (typeof value !== "string" || value.trim() === "") {
    const error = new Error("Missing file path.");
    error.code = "missing_path";
    throw error;
  }
  if (!path.isAbsolute(value)) {
    const error = new Error("Only absolute local file paths are supported.");
    error.code = "not_absolute";
    throw error;
  }
  return path.resolve(value);
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function failure(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

function errorFailure(error) {
  return failure(error?.code || "error", error?.message || String(error));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ------------------------------------------------------------- renderer side

function registerSettingsPage(state) {
  const { api } = state;
  if (typeof api.settings?.registerPage !== "function") {
    api.log.warn("registerPage unavailable; settings UI not mounted.");
    return;
  }

  state.pageHandle = api.settings.registerPage({
    id: "main",
    title: "File Editor",
    description: "Autosave behavior for editable right-panel files.",
    iconSvg:
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">' +
      '<path d="M5 3.5h7l3 3v10H5v-13Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M12 3.5V7h3M7.5 10h5M7.5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      "</svg>",
    render: (root) => renderSettings(root, state),
  });
}

function renderSettings(root, state) {
  root.textContent = "";

  const section = el("section", "codexpp-fe-settings");
  section.appendChild(sectionTitle("Autosave"));

  const card = el("div", "codexpp-fe-card");
  card.appendChild(
    toggleRow({
      title: "Enable autosave",
      description: "Save edited right-panel files after the editor is idle.",
      checked: readAutosaveEnabled(state.api),
      onChange: (checked) => {
        state.api.storage.set("autosave:enabled", checked);
        state.active?.setAutosaveEnabled(checked);
      },
    }),
  );
  card.appendChild(
    numberRow({
      title: "Autosave backoff",
      description: "Idle delay before writing changes to disk.",
      value: readAutosaveDelay(state.api),
      min: MIN_AUTOSAVE_DELAY_MS,
      max: MAX_AUTOSAVE_DELAY_MS,
      step: 250,
      suffix: "ms",
      onChange: (value) => {
        const next = clampDelay(value);
        state.api.storage.set("autosave:delayMs", next);
        state.active?.setAutosaveDelay(next);
      },
    }),
  );

  section.appendChild(card);
  root.appendChild(section);
}

function startRightPanelWatcher(state) {
  const schedule = () => scheduleScan(state);
  state._scheduleScan = schedule;

  state.observer = new MutationObserver(schedule);
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "aria-selected",
      "class",
      "data-app-shell-tab-controller",
      "data-review-path",
      "data-tab-id",
      "style",
    ],
  });

  document.addEventListener("click", schedule, true);
  window.addEventListener("resize", schedule);
  state.scanInterval = window.setInterval(schedule, 1500);
  schedule();
}

function scheduleScan(state) {
  if (state.disposed || state.scanning) return;
  state.scanning = true;
  try {
    scanRightPanel(state);
  } catch (error) {
    state.api.log.warn("file editor scan failed", error);
  } finally {
    state.scanning = false;
  }
}

function scanRightPanel(state) {
  if (state.disposed) return;

  const target = findActiveFileTarget();
  if (!target) {
    state.loading = null;
    state.active?.dispose();
    state.active = null;
    return;
  }

  if (state.active?.path === target.path && state.active.host === target.host) {
    return;
  }

  if (
    state.loading?.path === target.path &&
    state.loading?.host === target.host
  ) {
    return;
  }

  state.active?.dispose();
  state.active = null;
  mountEditor(state, target);
}

async function mountEditor(state, target) {
  const { api } = state;
  state.loading = { path: target.path, host: target.host };

  const result = await api.ipc.invoke("read-file", target.path);
  if (
    state.disposed ||
    state.loading?.path !== target.path ||
    state.loading?.host !== target.host
  ) {
    return;
  }
  state.loading = null;

  const current = findActiveFileTarget();
  if (!current || current.path !== target.path || current.host !== target.host) {
    return;
  }

  const editorState = createEditorState(state, target, result);
  state.active = editorState;
}

function findActiveFileTarget() {
  const panel = document.querySelector(
    '[data-app-shell-focus-area="right-panel"]',
  );
  if (!(panel instanceof HTMLElement)) return null;

  const pathFromReview = findVisibleReviewPath(panel);
  const path = pathFromReview || findActiveTabPath(panel);
  if (!path || !path.startsWith("/")) return null;

  const review =
    findReviewElement(panel, path) ||
    (pathFromReview ? null : panel.querySelector("[data-review-path]"));
  if (!(review instanceof HTMLElement)) return null;

  const host = findEditorHost(review);
  if (!(host instanceof HTMLElement)) return null;

  return { panel, path, review, host };
}

function findVisibleReviewPath(panel) {
  const reviews = Array.from(panel.querySelectorAll("[data-review-path]"));
  for (const review of reviews) {
    if (!(review instanceof HTMLElement)) continue;
    if (review.closest("[data-codexpp-file-editor]")) continue;
    const rect = review.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const path = review.getAttribute("data-review-path");
    if (path) return path;
  }
  return null;
}

function findActiveTabPath(panel) {
  const tabs = Array.from(
    panel.querySelectorAll(
      '[data-app-shell-tab-controller="right"][data-tab-id^="file:"]',
    ),
  );
  const active =
    tabs.find((tab) => {
      const button = tab.querySelector('button[role="tab"]');
      if (!(button instanceof HTMLElement)) return false;
      if (button.getAttribute("aria-selected") === "true") return true;
      return button.className.includes("text-token-text-primary");
    }) || tabs[0];
  if (!(active instanceof HTMLElement)) return null;
  return pathFromTabId(active.getAttribute("data-tab-id"));
}

function pathFromTabId(tabId) {
  if (!tabId || !tabId.startsWith("file:")) return null;
  let raw = tabId.slice("file:".length);
  if (raw.startsWith("local:")) raw = raw.slice("local:".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function findReviewElement(panel, filePath) {
  const escaped = cssEscape(filePath);
  return panel.querySelector(`[data-review-path="${escaped}"]`);
}

function findEditorHost(review) {
  return (
    review.closest(".h-full.overflow-auto") ||
    review.closest("[role='tabpanel']") ||
    review.parentElement
  );
}

function createEditorState(rootState, target, readResult) {
  const { api } = rootState;
  const previous = {
    position: target.host.style.position,
    overflow: target.host.style.overflow,
  };
  target.host.style.position = target.host.style.position || "relative";
  target.host.style.overflow = "hidden";
  target.host.dataset.codexppFileEditorHost = "true";

  const editor = {
    api,
    path: target.path,
    host: target.host,
    expectedMtimeMs: readResult?.mtimeMs,
    content: readResult?.ok ? readResult.content : "",
    lastSavedContent: readResult?.ok ? readResult.content : "",
    autosaveEnabled: readAutosaveEnabled(api),
    autosaveDelayMs: readAutosaveDelay(api),
    saveTimer: null,
    saving: false,
    dirty: false,
    conflicted: false,
    retryDelayMs: readAutosaveDelay(api),
    retrying: false,
    statusHideTimer: null,
    statusClearTimer: null,
    disposed: false,
    setAutosaveEnabled(enabled) {
      editor.autosaveEnabled = enabled;
      if (enabled && editor.dirty && !editor.conflicted) {
        scheduleAutosave(editor);
      } else if (!enabled) {
        clearSaveTimer(editor);
      }
    },
    setAutosaveDelay(delayMs) {
      editor.autosaveDelayMs = clampDelay(delayMs);
      editor.retryDelayMs = editor.autosaveDelayMs;
      if (editor.dirty && editor.autosaveEnabled && !editor.conflicted) {
        scheduleAutosave(editor);
      }
    },
    dispose() {
      editor.disposed = true;
      clearSaveTimer(editor);
      clearStatusHideTimer(editor);
      if (editor.dirty && editor.autosaveEnabled && !editor.conflicted) {
        void saveEditor(editor, { force: false, reason: "unmount" });
      }
      editor.overlay.remove();
      target.host.style.position = previous.position;
      target.host.style.overflow = previous.overflow;
      delete target.host.dataset.codexppFileEditorHost;
    },
  };

  editor.overlay = buildEditorOverlay(editor, readResult);
  target.host.appendChild(editor.overlay);
  return editor;
}

function buildEditorOverlay(editor, readResult) {
  const overlay = el("div", "codexpp-file-editor");
  overlay.dataset.codexppFileEditor = "true";

  const toolbar = el("div", "codexpp-file-editor-toolbar");
  const title = el("div", "codexpp-file-editor-title");
  title.title = editor.path;
  title.textContent = basename(editor.path);

  const status = el("span", "codexpp-file-editor-status");
  status.hidden = true;
  editor.statusNode = status;

  const left = el("div", "codexpp-file-editor-toolbar-left");
  left.appendChild(title);
  left.appendChild(status);

  toolbar.appendChild(left);
  overlay.appendChild(toolbar);

  if (!readResult?.ok) {
    const error = el("div", "codexpp-file-editor-error");
    const heading = el("div", "codexpp-file-editor-error-title");
    heading.textContent = "Cannot edit this file";
    const message = el("div", "codexpp-file-editor-error-message");
    message.textContent = readResult?.message || "The file could not be read.";
    error.appendChild(heading);
    error.appendChild(message);
    overlay.appendChild(error);
    setStatus(editor, "Read failed", "error");
    return overlay;
  }

  const body = el("div", "codexpp-file-editor-body");
  const gutter = el("div", "codexpp-file-editor-gutter");
  const codePane = el("div", "codexpp-file-editor-codepane");
  const highlight = document.createElement("pre");
  highlight.className = "codexpp-file-editor-highlight";
  highlight.setAttribute("aria-hidden", "true");
  const highlightCode = document.createElement("code");
  highlight.appendChild(highlightCode);
  const textarea = document.createElement("textarea");
  textarea.className = "codexpp-file-editor-textarea";
  textarea.value = editor.content;
  textarea.spellcheck = false;
  textarea.tabIndex = -1;
  textarea.wrap = "off";
  textarea.setAttribute("aria-label", `Edit ${basename(editor.path)}`);

  editor.gutter = gutter;
  editor.highlight = highlight;
  editor.highlightCode = highlightCode;
  editor.textarea = textarea;

  textarea.addEventListener("input", () => {
    const wasConflicted = editor.conflicted;
    editor.content = textarea.value;
    editor.dirty = editor.content !== editor.lastSavedContent;
    editor.retrying = false;
    editor.retryDelayMs = editor.autosaveDelayMs;
    updateGutter(editor);
    updateHighlight(editor);
    if (wasConflicted) {
      editor.conflicted = true;
      clearSaveTimer(editor);
      setStatus(editor, "Changed on disk", "error");
      return;
    }
    updateStatusAfterInput(editor);
    if (editor.dirty && editor.autosaveEnabled) {
      scheduleAutosave(editor);
    } else {
      clearSaveTimer(editor);
    }
  });

  textarea.addEventListener("scroll", () => {
    gutter.scrollTop = textarea.scrollTop;
    syncHighlightScroll(editor);
  });

  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveEditor(editor, {
        force: editor.conflicted,
        reason: "keyboard",
      });
      return;
    }

    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      insertTextAtSelection(textarea, "  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  codePane.appendChild(highlight);
  codePane.appendChild(textarea);
  body.appendChild(gutter);
  body.appendChild(codePane);
  overlay.appendChild(body);

  updateGutter(editor);
  updateHighlight(editor);
  hideStatus(editor);
  return overlay;
}

function updateStatusAfterInput(editor) {
  if (!editor.dirty) hideStatus(editor);
}

function updateGutter(editor) {
  if (!editor.gutter || !editor.textarea) return;
  const lineCount = Math.max(1, editor.textarea.value.split("\n").length);
  let text = "";
  for (let i = 1; i <= lineCount; i += 1) {
    text += i;
    if (i !== lineCount) text += "\n";
  }
  editor.gutter.textContent = text;
}

function updateHighlight(editor) {
  if (!editor.highlightCode || !editor.textarea) return;
  editor.highlightCode.innerHTML = highlightSyntax(editor.textarea.value, editor.path);
  syncHighlightScroll(editor);
}

function syncHighlightScroll(editor) {
  if (!editor.highlight || !editor.textarea) return;
  editor.highlight.scrollTop = editor.textarea.scrollTop;
  editor.highlight.scrollLeft = editor.textarea.scrollLeft;
}

function scheduleAutosave(editor) {
  clearSaveTimer(editor);
  if (editor.disposed || !editor.autosaveEnabled || editor.conflicted) return;
  editor.saveTimer = window.setTimeout(() => {
    editor.saveTimer = null;
    void saveEditor(editor, { force: false, reason: "autosave" });
  }, editor.autosaveDelayMs);
}

function clearSaveTimer(editor) {
  if (editor.saveTimer) {
    window.clearTimeout(editor.saveTimer);
    editor.saveTimer = null;
  }
}

async function saveEditor(editor, options) {
  if (editor.disposed) return;
  if (!editor.textarea) return;
  if (editor.saving) {
    scheduleAutosave(editor);
    return;
  }

  clearSaveTimer(editor);
  editor.saving = true;
  editor.retrying = false;

  const content = editor.textarea.value;
  const response = await editor.api.ipc.invoke("write-file", {
    path: editor.path,
    content,
    expectedMtimeMs: editor.expectedMtimeMs,
    force: options?.force === true,
  });

  editor.saving = false;
  if (editor.disposed) return;

  if (response?.ok) {
    editor.expectedMtimeMs = response.mtimeMs;
    editor.lastSavedContent = content;
    editor.content = content;
    editor.dirty = false;
    editor.conflicted = false;
    editor.retryDelayMs = editor.autosaveDelayMs;
    setStatus(editor, "Saved", "saved");
    return;
  }

  if (response?.code === "conflict") {
    editor.conflicted = true;
    editor.expectedMtimeMs = response.mtimeMs;
    setStatus(editor, "Changed on disk", "error");
    return;
  }

  const message = response?.message || "Save failed";
  editor.api.log.warn("file save failed", {
    path: editor.path,
    reason: options?.reason,
    message,
  });
  setStatus(
    editor,
    `Save failed; retrying in ${formatDelay(editor.retryDelayMs)}`,
    "error",
  );
  if (editor.autosaveEnabled) {
    editor.retrying = true;
    editor.saveTimer = window.setTimeout(() => {
      editor.saveTimer = null;
      editor.retryDelayMs = Math.min(editor.retryDelayMs * 2, MAX_AUTOSAVE_DELAY_MS);
      void saveEditor(editor, { force: false, reason: "retry" });
    }, editor.retryDelayMs);
  }
}

async function reloadEditor(editor) {
  if (editor.disposed) return;
  clearSaveTimer(editor);
  const response = await editor.api.ipc.invoke("read-file", editor.path);
  if (editor.disposed) return;
  if (!response?.ok) {
    setStatus(editor, response?.message || "Reload failed", "error");
    return;
  }

  editor.expectedMtimeMs = response.mtimeMs;
  editor.content = response.content;
  editor.lastSavedContent = response.content;
  editor.dirty = false;
  editor.conflicted = false;
  editor.retryDelayMs = editor.autosaveDelayMs;
  editor.textarea.value = response.content;
  updateGutter(editor);
  updateHighlight(editor);
  hideStatus(editor);
}

function hideStatus(editor) {
  if (!editor.statusNode) return;
  clearStatusHideTimer(editor);
  editor.statusNode.hidden = true;
  editor.statusNode.textContent = "";
  editor.statusNode.classList.remove("is-hiding");
}

function setStatus(editor, text, tone) {
  if (!editor.statusNode) return;
  clearStatusHideTimer(editor);
  editor.statusNode.textContent = text;
  editor.statusNode.dataset.tone = tone || "neutral";
  editor.statusNode.classList.remove("is-hiding");
  editor.statusNode.hidden = false;
  if (tone === "saved") {
    editor.statusHideTimer = window.setTimeout(() => {
      editor.statusHideTimer = null;
      if (editor.statusNode?.dataset.tone === "saved") {
        editor.statusNode.classList.add("is-hiding");
        editor.statusClearTimer = window.setTimeout(() => {
          editor.statusClearTimer = null;
          if (editor.statusNode?.dataset.tone === "saved") {
            editor.statusNode.hidden = true;
            editor.statusNode.textContent = "";
            editor.statusNode.classList.remove("is-hiding");
          }
        }, 180);
      }
    }, 2000);
  }
}

function clearStatusHideTimer(editor) {
  if (editor.statusHideTimer) {
    window.clearTimeout(editor.statusHideTimer);
    editor.statusHideTimer = null;
  }
  if (editor.statusClearTimer) {
    window.clearTimeout(editor.statusClearTimer);
    editor.statusClearTimer = null;
  }
  editor.statusNode?.classList.remove("is-hiding");
}

function insertTextAtSelection(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

function readAutosaveEnabled(api) {
  const value = api.storage.get("autosave:enabled", undefined);
  return typeof value === "boolean" ? value : true;
}

function readAutosaveDelay(api) {
  return clampDelay(api.storage.get("autosave:delayMs", DEFAULT_AUTOSAVE_DELAY_MS));
}

function clampDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_AUTOSAVE_DELAY_MS;
  return Math.max(
    MIN_AUTOSAVE_DELAY_MS,
    Math.min(MAX_AUTOSAVE_DELAY_MS, Math.round(number)),
  );
}

function basename(filePath) {
  const parts = String(filePath || "").split("/");
  return parts[parts.length - 1] || filePath;
}

function formatDelay(ms) {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

function highlightSyntax(text, filePath) {
  if (!text) return "";
  if (text.length > HIGHLIGHT_MAX_CHARS) return preserveTrailingNewline(escapeHtml(text));

  const lang = languageForPath(filePath);
  if (lang === "markup") return highlightMarkup(text);
  if (lang === "css") return highlightCss(text);
  if (lang === "json") return highlightJson(text);
  if (lang === "shell") return highlightPattern(text, shellPattern(), classifyShellToken);
  if (lang === "python") return highlightPattern(text, pythonPattern(), classifyPythonToken);
  if (lang === "code") return highlightPattern(text, codePattern(), classifyCodeToken);
  return preserveTrailingNewline(escapeHtml(text));
}

function languageForPath(filePath) {
  const name = basename(filePath).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "go", "rs", "java", "c", "cc", "cpp", "h", "hpp", "swift", "kt", "rb", "php"].includes(ext)) {
    return "code";
  }
  if (["json", "jsonc", "map", "lock"].includes(ext) || name.endsWith("package-lock.json")) {
    return "json";
  }
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(ext)) return "markup";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["sh", "bash", "zsh", "fish"].includes(ext) || [".zshrc", ".bashrc", ".bash_profile", ".profile"].includes(name)) {
    return "shell";
  }
  if (["py", "pyw"].includes(ext)) return "python";
  return "plain";
}

function highlightPattern(text, pattern, classify) {
  let html = "";
  let lastIndex = 0;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index || 0;
    if (index > lastIndex) html += escapeHtml(text.slice(lastIndex, index));
    const cls = classify(token);
    html += cls ? span(cls, token) : escapeHtml(token);
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) html += escapeHtml(text.slice(lastIndex));
  return preserveTrailingNewline(html);
}

function codePattern() {
  return /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:abstract|as|async|await|break|case|catch|class|const|continue|default|defer|delete|do|else|enum|export|extends|false|final|finally|for|from|func|function|get|guard|if|implements|import|in|interface|is|let|match|mut|new|null|package|private|protected|public|return|self|set|static|struct|super|switch|this|throw|throws|trait|true|try|type|typeof|var|void|while|yield)\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}()[\],.;:+\-*/%=&|!<>?~^]+/gi;
}

function classifyCodeToken(token) {
  if (token.startsWith("//") || token.startsWith("/*")) return "tok-comment";
  if (token[0] === '"' || token[0] === "'" || token[0] === "`") return "tok-string";
  if (/^\d/.test(token)) return "tok-number";
  if (/^[A-Za-z_$]/.test(token)) {
    return CODE_KEYWORDS.has(token.toLowerCase()) ? "tok-keyword" : "tok-function";
  }
  return "tok-punctuation";
}

const CODE_KEYWORDS = new Set(
  "abstract as async await break case catch class const continue default defer delete do else enum export extends false final finally for from func function get guard if implements import in interface is let match mut new null package private protected public return self set static struct super switch this throw throws trait true try type typeof var void while yield".split(" "),
);

function jsonPattern() {
  return /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}[\],:]/gi;
}

function highlightJson(text) {
  return highlightPattern(text, jsonPattern(), (token) => {
    if (token[0] === '"') return /"\s*$/.test(token) ? "tok-string" : "tok-property";
    if (/^(true|false|null)$/i.test(token)) return "tok-keyword";
    if (/^-?\d/.test(token)) return "tok-number";
    return "tok-punctuation";
  });
}

function highlightCss(text) {
  return highlightPattern(
    text,
    /\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|#[\da-f]{3,8}\b|\b-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg)?\b|[.#]?[A-Za-z_-][\w-]*(?=\s*:)|[{}()[\],.;:+\-*/%=&|!<>?~^]+/gi,
    (token) => {
      if (token.startsWith("/*")) return "tok-comment";
      if (token[0] === '"' || token[0] === "'") return "tok-string";
      if (token.startsWith("#") || /^-?\d/.test(token)) return "tok-number";
      if (/^[.#]?[A-Za-z_-]/.test(token)) return "tok-property";
      return "tok-punctuation";
    },
  );
}

function highlightMarkup(text) {
  return highlightPattern(
    text,
    /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*(?:\s+[A-Za-z_:][\w:.-]*(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[<>/=]+/g,
    (token) => {
      if (token.startsWith("<!--")) return "tok-comment";
      if (token.startsWith("<")) return "tok-tag";
      if (token[0] === '"' || token[0] === "'") return "tok-string";
      return "tok-punctuation";
    },
  );
}

function shellPattern() {
  return /#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$\{?[A-Za-z_][\w]*\}?|\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|then|while)\b|\b\d+\b|[{}()[\],.;:+\-*/%=&|!<>?~^]+/g;
}

function classifyShellToken(token) {
  if (token.startsWith("#")) return "tok-comment";
  if (token[0] === '"' || token[0] === "'") return "tok-string";
  if (token.startsWith("$")) return "tok-property";
  if (/^\d/.test(token)) return "tok-number";
  if (/^[A-Za-z]/.test(token)) return "tok-keyword";
  return "tok-punctuation";
}

function pythonPattern() {
  return /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b|\b[A-Za-z_]\w*(?=\s*\()|\b\d+(?:\.\d+)?\b|[{}()[\],.;:+\-*/%=&|!<>?~^]+/g;
}

function classifyPythonToken(token) {
  if (token.startsWith("#")) return "tok-comment";
  if (token[0] === '"' || token[0] === "'") return "tok-string";
  if (/^\d/.test(token)) return "tok-number";
  if (PYTHON_KEYWORDS.has(token)) return "tok-keyword";
  if (/^[A-Za-z_]/.test(token)) return "tok-function";
  return "tok-punctuation";
}

const PYTHON_KEYWORDS = new Set(
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" "),
);

function span(className, text) {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function preserveTrailingNewline(html) {
  return html.endsWith("\n") ? `${html} ` : html;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"').replace(/\\/g, "\\\\");
}

// ------------------------------------------------------------------ DOM/CSS

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function sectionTitle(text) {
  const title = el("div", "codexpp-fe-section-title");
  title.textContent = text;
  return title;
}

function toggleRow(options) {
  const row = el("div", "codexpp-fe-row");
  const text = el("div", "codexpp-fe-row-text");
  const title = el("div", "codexpp-fe-row-title");
  title.textContent = options.title;
  const description = el("div", "codexpp-fe-row-description");
  description.textContent = options.description;
  text.appendChild(title);
  text.appendChild(description);

  row.appendChild(text);
  row.appendChild(
    switchControl(!!options.checked, async (checked) => {
      await options.onChange(checked);
    }, options.title),
  );
  return row;
}

function switchControl(initial, onChange, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "switch");
  if (label) button.setAttribute("aria-label", label);

  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className =
    "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] " +
    "shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  button.appendChild(pill);

  const apply = (enabled) => {
    button.setAttribute("aria-checked", String(enabled));
    button.dataset.state = enabled ? "checked" : "unchecked";
    button.className =
      "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 " +
      "focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className =
      "relative inline-flex shrink-0 items-center rounded-full transition-colors " +
      "duration-200 ease-out h-5 w-8 " +
      (enabled ? "bg-token-charts-blue" : "bg-token-foreground/20");
    pill.dataset.state = enabled ? "checked" : "unchecked";
    knob.dataset.state = enabled ? "checked" : "unchecked";
    knob.style.transform = enabled ? "translateX(14px)" : "translateX(2px)";
  };

  apply(initial);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = button.getAttribute("aria-checked") !== "true";
    apply(next);
    button.disabled = true;
    try {
      await onChange?.(next);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function numberRow(options) {
  const row = el("div", "codexpp-fe-row");
  const text = el("div", "codexpp-fe-row-text");
  const title = el("div", "codexpp-fe-row-title");
  title.textContent = options.title;
  const description = el("div", "codexpp-fe-row-description");
  description.textContent = options.description;
  text.appendChild(title);
  text.appendChild(description);

  const control = el("div", "codexpp-fe-number-control");
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  input.className = "codexpp-fe-number";
  input.addEventListener("change", () => {
    const next = clampDelay(input.value);
    input.value = String(next);
    options.onChange(next);
  });
  const suffix = el("span", "codexpp-fe-suffix");
  suffix.textContent = options.suffix;
  control.appendChild(input);
  control.appendChild(suffix);

  row.appendChild(text);
  row.appendChild(control);
  return row;
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .codexpp-file-editor {
      position: absolute;
      inset: 0;
      z-index: 40;
      display: flex;
      min-width: 0;
      min-height: 0;
      flex-direction: column;
      background: var(--codexpp-file-editor-bg, #101113);
      color: inherit;
    }

    .codexpp-file-editor-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 38px;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      background: color-mix(in srgb, currentColor 3%, transparent);
      flex-shrink: 0;
    }

    .codexpp-file-editor-toolbar-left {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 8px;
    }

    .codexpp-file-editor-title {
      min-width: 0;
      max-width: min(34vw, 360px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 600;
    }

    .codexpp-file-editor-status {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      line-height: 16px;
      background: color-mix(in srgb, currentColor 8%, transparent);
      opacity: 1;
      transform: translateY(0);
      transition:
        opacity 160ms ease,
        transform 160ms ease;
    }

    .codexpp-file-editor-status.is-hiding {
      opacity: 0;
      transform: translateY(-3px);
    }

    .codexpp-file-editor-status[data-tone="dirty"] {
      color: #f2c94c;
      background: color-mix(in srgb, #f2c94c 18%, transparent);
    }

    .codexpp-file-editor-status[data-tone="saving"] {
      color: #7bb7ff;
      background: color-mix(in srgb, #7bb7ff 18%, transparent);
    }

    .codexpp-file-editor-status[data-tone="saved"] {
      color: #7edc9a;
      background: color-mix(in srgb, #7edc9a 16%, transparent);
    }

    .codexpp-file-editor-status[data-tone="error"] {
      color: #ff8d8d;
      background: color-mix(in srgb, #ff8d8d 18%, transparent);
    }

    .codexpp-file-editor-body {
      display: grid;
      grid-template-columns: minmax(42px, max-content) minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      flex: 1;
      overflow: hidden;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 20px;
    }

    .codexpp-file-editor-gutter {
      min-width: 42px;
      overflow: hidden;
      border-right: 1px solid color-mix(in srgb, currentColor 10%, transparent);
      padding: 14px 9px 14px 10px;
      text-align: right;
      user-select: none;
      white-space: pre;
      opacity: 0.45;
    }

    .codexpp-file-editor-codepane {
      position: relative;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    .codexpp-file-editor-highlight {
      position: absolute;
      inset: 0;
      margin: 0;
      padding: 14px 16px;
      overflow: auto;
      pointer-events: none;
      white-space: pre;
      color: color-mix(in srgb, currentColor 82%, transparent);
      font: inherit;
      line-height: inherit;
      tab-size: 2;
    }

    .codexpp-file-editor-highlight::-webkit-scrollbar {
      display: none;
    }

    .codexpp-file-editor-highlight {
      scrollbar-width: none;
    }

    .codexpp-file-editor-highlight code {
      font: inherit;
      line-height: inherit;
    }

    .codexpp-file-editor-textarea {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      resize: none;
      border: 0;
      outline: none;
      padding: 14px 16px;
      background: transparent;
      color: transparent;
      caret-color: var(--color-token-text-primary, #f2f2f2);
      font: inherit;
      line-height: inherit;
      overflow: auto;
      tab-size: 2;
      white-space: pre;
      -webkit-text-fill-color: transparent;
    }

    .codexpp-file-editor-textarea::selection {
      background: color-mix(in srgb, #7bb7ff 32%, transparent);
      -webkit-text-fill-color: transparent;
    }

    .codexpp-file-editor-highlight .tok-comment {
      color: #7a8a7a;
    }

    .codexpp-file-editor-highlight .tok-string {
      color: #d6b676;
    }

    .codexpp-file-editor-highlight .tok-keyword {
      color: #c792ea;
    }

    .codexpp-file-editor-highlight .tok-number {
      color: #89c2ff;
    }

    .codexpp-file-editor-highlight .tok-function {
      color: #82d0d8;
    }

    .codexpp-file-editor-highlight .tok-property {
      color: #9cdcfe;
    }

    .codexpp-file-editor-highlight .tok-tag {
      color: #f08d8d;
    }

    .codexpp-file-editor-highlight .tok-punctuation {
      color: color-mix(in srgb, currentColor 68%, transparent);
    }

    .codexpp-file-editor-error {
      display: flex;
      min-height: 0;
      flex: 1;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
      padding: 24px;
    }

    .codexpp-file-editor-error-title {
      font-size: 13px;
      font-weight: 600;
    }

    .codexpp-file-editor-error-message {
      max-width: 520px;
      font-size: 12px;
      opacity: 0.72;
    }

    .codexpp-fe-settings {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .codexpp-fe-section-title {
      padding: 0;
      font-size: 15px;
      font-weight: 600;
    }

    .codexpp-fe-card {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      border-radius: 8px;
    }

    .codexpp-fe-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    }

    .codexpp-fe-row:last-child {
      border-bottom: 0;
    }

    .codexpp-fe-row-text {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 3px;
    }

    .codexpp-fe-row-title {
      font-size: 13px;
      font-weight: 500;
    }

    .codexpp-fe-row-description {
      font-size: 12px;
      opacity: 0.68;
    }

    .codexpp-fe-number-control {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 6px;
    }

    .codexpp-fe-number {
      width: 92px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, currentColor 5%, transparent);
      color: inherit;
      font: inherit;
      font-size: 12px;
      padding: 4px 7px;
    }

    .codexpp-fe-suffix {
      font-size: 12px;
      opacity: 0.65;
    }
  `;
  document.head.appendChild(style);
}

function removeStylesIfUnused() {
  if (document.querySelector("[data-codexpp-file-editor]")) return;
  document.getElementById(STYLE_ID)?.remove();
}
