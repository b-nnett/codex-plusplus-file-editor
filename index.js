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
const MAIN_STATE_KEY = "__codexpp_file_editor_main_state__";
const PATCH_RENDERER_ASSET_KEY = "__codexpp_file_editor_patch_renderer_asset__";
const RELOAD_TOKEN_KEY = "__codexpp_file_editor_reload_token__";

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    if (api.process === "main") {
      const previous = globalThis[MAIN_STATE_KEY];
      if (previous && typeof previous.dispose === "function") {
        try {
          previous.dispose();
        } catch (error) {
          api.log.warn("failed to dispose previous file editor main state", error);
        }
      }
      const state = { api, disposers: [], patchedAssets: new Set() };
      state.dispose = () => stopMain(state);
      globalThis[MAIN_STATE_KEY] = state;
      globalThis[PATCH_RENDERER_ASSET_KEY] = patchRendererAsset;
      this._state = state;
      startMain(api, state);
      reloadExistingAppWindowsIfHotEnabled(api);
      return;
    }

    globalThis.__codexppFileEditorRendererState?.disposeRenderer?.();

    const state = {
      api,
      active: null,
      loading: null,
      observer: null,
      pageHandle: null,
      fileTreeCreateInline: null,
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
    if (state.disposeRenderer) {
      disposeRendererState(state);
      if (globalThis.__codexppFileEditorRendererState === state) {
        delete globalThis.__codexppFileEditorRendererState;
      }
    } else if (typeof state.dispose === "function") {
      state.dispose();
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
  closeFileTreeCreateInline(state);
  removeFileTreeCreateControls();
  state.pageHandle?.unregister();
  state.pageHandle = null;
  removeStylesIfUnused();
}

// ---------------------------------------------------------------- main side

function stopMain(state) {
  if (globalThis[MAIN_STATE_KEY] === state) {
    delete globalThis[MAIN_STATE_KEY];
  }
  if (globalThis[PATCH_RENDERER_ASSET_KEY] === patchRendererAsset) {
    delete globalThis[PATCH_RENDERER_ASSET_KEY];
  }
  for (const dispose of state.disposers.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      state.api.log.warn("file editor main dispose failed", error);
    }
  }
}

function startMain(api, state) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { clipboard, shell } = require("electron");

  installProtocolPatch(api, state);

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
      const atomic = payload?.atomic !== false;

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

      if (atomic) {
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
      } else {
        await fs.promises.writeFile(normalized, content, "utf8");
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

  registry.handlers["list-dir"] = async (dirPath) => {
    try {
      const normalized = normalizeLocalFilePath(path, dirPath);
      const stat = await fs.promises.stat(normalized);
      if (!stat.isDirectory()) {
        return failure("not_directory", "The selected path is not a directory.");
      }

      const entries = await fs.promises.readdir(normalized, {
        withFileTypes: true,
      });
      const items = [];
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const fullPath = path.join(normalized, entry.name);
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        });
      }
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
      return { ok: true, path: normalized, entries: items };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["create-file"] = async (payload) => {
    try {
      const { parent, target, name } = resolveCreateTarget(path, payload);
      const stat = await fs.promises.stat(parent);
      if (!stat.isDirectory()) {
        return failure("not_directory", "The selected parent is not a directory.");
      }

      await fs.promises.writeFile(target, "", { encoding: "utf8", flag: "wx" });
      const nextStat = await fs.promises.stat(target);
      return {
        ok: true,
        path: target,
        parentPath: parent,
        name,
        isFile: true,
        isDirectory: false,
        mtimeMs: nextStat.mtimeMs,
        size: nextStat.size,
      };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["create-folder"] = async (payload) => {
    try {
      const { parent, target, name } = resolveCreateTarget(path, payload);
      const stat = await fs.promises.stat(parent);
      if (!stat.isDirectory()) {
        return failure("not_directory", "The selected parent is not a directory.");
      }

      await fs.promises.mkdir(target, { recursive: false });
      return {
        ok: true,
        path: target,
        parentPath: parent,
        name,
        isFile: false,
        isDirectory: true,
      };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["copy-path"] = async (filePath) => {
    try {
      const normalized = normalizeLocalFilePath(path, filePath);
      clipboard.writeText(normalized);
      return { ok: true, path: normalized };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["open-in-file-explorer"] = async (filePath) => {
    try {
      const normalized = normalizeLocalFilePath(path, filePath);
      const stat = await fs.promises.stat(normalized);
      if (stat.isDirectory()) {
        const message = await shell.openPath(normalized);
        if (message) return failure("open_failed", message);
      } else {
        shell.showItemInFolder(normalized);
      }
      return { ok: true, path: normalized };
    } catch (error) {
      return errorFailure(error);
    }
  };

  registry.handlers["platform-file-explorer"] = async () => ({
    ok: true,
    label: platformFileExplorerLabel(process.platform),
  });

  const channels = [
    "read-file",
    "write-file",
    "stat-file",
    "list-dir",
    "create-file",
    "create-folder",
    "copy-path",
    "open-in-file-explorer",
    "platform-file-explorer",
  ];
  registry.registeredChannels ||= new Set(
    registry.registered ? ["read-file", "write-file", "stat-file"] : [],
  );
  for (const channel of channels) {
    if (!registry.registeredChannels.has(channel)) {
      api.ipc.handle(channel, (...args) =>
        registry.handlers[channel](...args),
      );
      registry.registeredChannels.add(channel);
    }
  }
  registry.registered = true;

  api.log.info("file editor main handlers ready", { tmp: os.tmpdir() });
}

function installProtocolPatch(api, state) {
  const { protocol } = require("electron");
  const originalHandle = protocol.handle;

  protocol.handle = function fileEditorProtocolHandle(scheme, handler) {
    if (scheme !== "app" || typeof handler !== "function") {
      return originalHandle.apply(this, arguments);
    }

    const wrappedHandler = async (request) => {
      const response = await handler(request);
      if (!shouldPatchRendererAsset(request?.url)) return response;

      let originalText = null;
      try {
        originalText = await response.text();
        const patcher = globalThis[PATCH_RENDERER_ASSET_KEY] ?? patchRendererAsset;
        const patchedText = patcher(request.url, originalText);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.set("content-type", "text/javascript; charset=utf-8");

        const assetName = assetPatchKind(request.url);
        if (patchedText !== originalText && !state.patchedAssets.has(assetName)) {
          state.patchedAssets.add(assetName);
          api.log.info("patched renderer asset", { assetName });
        }

        return new Response(patchedText, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        api.log.warn("failed to patch file editor renderer asset", {
          url: request?.url,
          error: error?.stack || error?.message || String(error),
        });
        if (originalText != null) {
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(originalText, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
        return response;
      }
    };

    return originalHandle.call(this, scheme, wrappedHandler);
  };

  state.disposers.push(() => {
    protocol.handle = originalHandle;
  });
}

function shouldPatchRendererAsset(rawUrl) {
  return assetPatchKind(rawUrl) != null;
}

function assetPatchKind(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  let basename;
  try {
    const pathname = new URL(rawUrl).pathname;
    basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  } catch {
    return null;
  }
  if (/^use-model-settings-[A-Za-z0-9_]+\.js$/.test(basename)) {
    return "use-model-settings";
  }
  return null;
}

function patchRendererAsset(rawUrl, source) {
  if (assetPatchKind(rawUrl) !== "use-model-settings") return source;
  return patchUseModelSettings(source);
}

function patchUseModelSettings(source) {
  const target =
    "function VD(e){let t=(0,q.c)(13),[n,r]=V(`diff_comments`),[i]=V(`diff_comments_from_model`),a;t[0]!==e||t[1]!==n?(a=n?.[e]??[],t[0]=e,t[1]=n,t[2]=a):a=t[2];let o=a,s;t[3]!==e||t[4]!==i?(s=i?.[e]??[],t[3]=e,t[4]=i,t[5]=s):s=t[5];let c=s,l;t[6]!==e||t[7]!==r?(l=t=>{r(n=>{let r={...n},i=r[e]??[],a=typeof t==`function`?t(i):t;return a.length===0?(r[e]===void 0||delete r[e],r):(r[e]=a,r)})},t[6]=e,t[7]=r,t[8]=l):l=t[8];let u=l,d;return t[9]!==o||t[10]!==c||t[11]!==u?(d={comments:o,modelComments:c,setComments:u},t[9]=o,t[10]=c,t[11]=u,t[12]=d):d=t[12],d}";
  if (!source.includes(target)) {
    throw new Error("missing patch target: diff comments hook");
  }
  const replacement =
    "function VD(e){let t=(0,q.c)(13),[n,r]=V(`diff_comments`),[i]=V(`diff_comments_from_model`),a;t[0]!==e||t[1]!==n?(a=n?.[e]??[],t[0]=e,t[1]=n,t[2]=a):a=t[2];let o=a,s;t[3]!==e||t[4]!==i?(s=i?.[e]??[],t[3]=e,t[4]=i,t[5]=s):s=t[5];let c=s,l;t[6]!==e||t[7]!==r?(l=t=>{r(n=>{let r={...n},i=r[e]??[],a=typeof t==`function`?t(i):t;return a.length===0?(r[e]===void 0||delete r[e],r):(r[e]=a,r)})},t[6]=e,t[7]=r,t[8]=l):l=t[8];let u=l,d;return globalThis.__codexppFileEditorDiffCommentsBridge||(globalThis.__codexppFileEditorDiffCommentsBridge={entries:new Map,submit(t){if(!t||typeof t!=`object`)return!1;let n=t.conversationId,r=n!=null?this.entries.get(n):null;if(r==null){for(let e of this.entries.values())(!r||e.updatedAt>r.updatedAt)&&(r=e)}return r?(r.setComments(e=>[...e,t.comment]),!0):!1},register(e,t){if(e!=null&&typeof t==`function`)this.entries.set(e,{setComments:t,updatedAt:Date.now()})}}),globalThis.__codexppFileEditorDiffCommentsBridge.listener||(globalThis.__codexppFileEditorDiffCommentsBridge.listener=!0,window.addEventListener(`__codexppFileEditorSubmitDiffComment`,e=>{let t=null,n=!1,r=null;try{let i=JSON.parse(e.detail);t=i.id,n=globalThis.__codexppFileEditorDiffCommentsBridge.submit(i)}catch(e){r=String(e?.message||e)}window.dispatchEvent(new CustomEvent(`__codexppFileEditorSubmitDiffCommentResult`,{detail:JSON.stringify({id:t,ok:n,error:r})}))})),globalThis.__codexppFileEditorDiffCommentsBridge.register(e,u),t[9]!==o||t[10]!==c||t[11]!==u?(d={comments:o,modelComments:c,setComments:u},t[9]=o,t[10]=c,t[11]=u,t[12]=d):d=t[12],d}";
  return source.replace(target, replacement);
}

function reloadExistingAppWindowsIfHotEnabled(api) {
  const { app, BrowserWindow } = require("electron");
  if (!app.isReady()) return;

  const token = getReloadToken();
  if (globalThis[RELOAD_TOKEN_KEY] === token) return;

  const windows = BrowserWindow.getAllWindows().filter((window) => {
    if (window.isDestroyed()) return false;
    return window.webContents.getURL().startsWith("app://-/");
  });
  if (windows.length === 0) return;

  globalThis[RELOAD_TOKEN_KEY] = token;
  setTimeout(() => {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        api.log.info("reloading Codex window to apply file editor renderer patch");
        window.webContents.reloadIgnoringCache();
      }
    }
  }, 200);
}

function getReloadToken() {
  try {
    const fs = require("node:fs");
    const stat = fs.statSync(__filename);
    return `${__filename}:${stat.mtimeMs}`;
  } catch {
    return `${__filename}:unknown`;
  }
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

function resolveCreateTarget(path, payload) {
  const parent = normalizeLocalFilePath(path, payload?.parentPath);
  const name = validateCreateName(payload?.name);
  const target = path.resolve(parent, name);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("File name must stay inside the selected folder.");
    error.code = "invalid_name";
    throw error;
  }
  return { parent, target, name };
}

function validateCreateName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    const error = new Error("Missing name.");
    error.code = "missing_name";
    throw error;
  }
  if (name === "." || name === ".." || /[\\/]/.test(name) || name.includes("\0")) {
    const error = new Error("Use a single file or folder name.");
    error.code = "invalid_name";
    throw error;
  }
  return name;
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
  if (error?.code === "EEXIST") {
    return failure("exists", "A file or folder already exists with that name.");
  }
  if (error?.code === "ENOENT") {
    return failure("not_found", "The selected path does not exist.");
  }
  return failure(error?.code || "error", error?.message || String(error));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function platformFileExplorerLabel(platform) {
  if (platform === "darwin") return "Finder";
  if (platform === "win32") return "File Explorer";
  return "File Manager";
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
      description: "Save edited right-panel files as local drafts after the editor is idle.",
      checked: readAutosaveEnabled(state.api),
      onChange: (checked) => {
        state.api.storage.set("autosave:enabled", checked);
        state.active?.setAutosaveEnabled(checked);
      },
    }),
  );
  card.appendChild(
    toggleRow({
      title: "Write autosaves to disk",
      description:
        "Persist idle autosaves to the file itself. This may trigger Codex file refreshes.",
      checked: readDiskAutosaveEnabled(state.api),
      onChange: (checked) => {
        state.api.storage.set("autosave:diskWrites", checked);
        state.active?.setDiskAutosaveEnabled(checked);
      },
    }),
  );
  card.appendChild(
    numberRow({
      title: "Autosave backoff",
      description: "Idle delay before saving a draft or disk autosave.",
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
    installFileTreeCreateControls(state);
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

function installFileTreeCreateControls(state) {
  if (state.disposed) return;

  const search = document.querySelector("#workspace-directory-tree-search");
  if (!(search instanceof HTMLInputElement)) return;

  const panel =
    search.closest('[data-app-shell-focus-area="right-panel"]') ||
    search.closest("[role='tabpanel']") ||
    document.body;
  if (!(panel instanceof HTMLElement)) return;

  installFileTreeFilterActions(state, panel, search);
  installFileTreeFolderRowActions(state, panel);
}

function installFileTreeFilterActions(state, panel, search) {
  const shell = findFileTreeSearchShell(search);
  if (!shell) return;

  let actions = Array.from(shell.children).find(
    (child) => child.dataset?.codexppFileTreeCreateActions === "true",
  );
  if (actions) return;

  actions = el("div", "codexpp-file-tree-create-actions");
  actions.dataset.codexppFileTreeCreate = "true";
  actions.dataset.codexppFileTreeCreateActions = "true";

  const newFile = createFileTreeToolbarButton(
    "New file",
    filePlusIcon(),
    (button) => {
      const parentPath = findFileTreeCreateRoot(panel, state);
      openFileTreeCreateInline(state, panel, parentPath, "file", button);
    },
  );
  const newFolder = createFileTreeToolbarButton(
    "New folder",
    folderPlusIcon(),
    (button) => {
      const parentPath = findFileTreeCreateRoot(panel, state);
      openFileTreeCreateInline(state, panel, parentPath, "folder", button);
    },
  );
  const feedback = el("span", "codexpp-file-tree-create-feedback");
  feedback.dataset.codexppFileTreeCreate = "true";
  feedback.dataset.codexppFileTreeCreateFeedback = "true";
  feedback.hidden = true;

  actions.appendChild(newFile);
  actions.appendChild(newFolder);
  actions.appendChild(feedback);
  shell.appendChild(actions);
}

function installFileTreeFolderRowActions(state, panel) {
  for (const item of findFileTreeFolderRows(panel)) {
    let control = Array.from(item.row.children).find(
      (child) => child.dataset?.codexppFileTreeRowCreate === "true",
    );

    if (!control) {
      control = createFileTreeRowButton("New file", filePlusIcon(), (button) => {
        openFileTreeCreateInline(
          state,
          panel,
          button.dataset.parentPath,
          "file",
          button,
        );
      });
      item.row.appendChild(control);
    }

    control.dataset.parentPath = item.path;
    control.title = `New file in ${basename(item.path) || item.path}`;
    control.setAttribute("aria-label", control.title);
    prepareFileTreeFolderRow(item.row);
  }
}

function findFileTreeSearchShell(search) {
  const candidates = [
    search.parentElement,
    search.closest(".relative.flex"),
    search.closest("[class*='h-token-button-composer']"),
  ];
  return candidates.find((node) => node instanceof HTMLElement) || null;
}

function findFileTreeFolderRows(panel) {
  const rows = new Map();
  const titled = Array.from(panel.querySelectorAll('[title^="/"]'));
  for (const node of titled) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(".codexpp-file-editor-menu")) continue;
    if (node.closest(".codexpp-file-editor-breadcrumb")) continue;
    if (node.closest("[data-codexpp-file-editor]")) continue;
    if (node.closest("[data-codexpp-file-tree-create-actions]")) continue;

    const title = node.getAttribute("title") || "";
    const row = findFileTreeRowForNode(node);
    if (!row || row.closest('nav[aria-label="File path"]')) continue;
    const rowTitle = row.getAttribute("title");
    if (rowTitle && rowTitle !== title) continue;
    const isFolder = title.endsWith("/") || row.hasAttribute("aria-expanded");
    if (!isFolder) continue;

    const folderPath = stripTrailingSlash(title);
    if (!folderPath.startsWith("/")) continue;
    rows.set(row, folderPath);
  }

  return Array.from(rows, ([row, path]) => ({ row, path }));
}

function findFileTreeRowForNode(node) {
  return (
    node.closest('[role="treeitem"]') ||
    node.closest("[aria-expanded]") ||
    node.closest("button") ||
    node.closest("[data-testid]") ||
    node
  );
}

function prepareFileTreeFolderRow(row) {
  if (row.dataset.codexppFileTreeCreatePositioned !== "true") {
    row.dataset.codexppFileTreeCreatePositioned = "true";
    row.dataset.codexppFileTreeOriginalPosition = row.style.position || "";
    row.dataset.codexppFileTreeOriginalPaddingRight =
      row.style.paddingRight || "";
  }
  if (window.getComputedStyle(row).position === "static") {
    row.style.position = "relative";
  }
  const paddingRight = parseFloat(window.getComputedStyle(row).paddingRight) || 0;
  if (paddingRight < 26) row.style.paddingRight = "28px";
}

function removeFileTreeCreateControls() {
  document
    .querySelectorAll("[data-codexpp-file-tree-create='true']")
    .forEach((node) => node.remove());
  document
    .querySelectorAll("[data-codexpp-file-tree-create-positioned='true']")
    .forEach((row) => {
      if (!(row instanceof HTMLElement)) return;
      row.style.position = row.dataset.codexppFileTreeOriginalPosition || "";
      row.style.paddingRight =
        row.dataset.codexppFileTreeOriginalPaddingRight || "";
      delete row.dataset.codexppFileTreeCreatePositioned;
      delete row.dataset.codexppFileTreeOriginalPosition;
      delete row.dataset.codexppFileTreeOriginalPaddingRight;
    });
}

function createFileTreeToolbarButton(label, icon, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "codexpp-file-tree-create-button";
  button.dataset.codexppFileTreeCreate = "true";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.(button);
  });
  return button;
}

function createFileTreeRowButton(label, icon, onActivate) {
  const button = el(
    "span",
    "codexpp-file-tree-create-button codexpp-file-tree-row-create",
  );
  button.dataset.codexppFileTreeCreate = "true";
  button.dataset.codexppFileTreeRowCreate = "true";
  button.setAttribute("role", "button");
  button.setAttribute("aria-label", label);
  button.tabIndex = 0;
  button.title = label;
  button.innerHTML = icon;

  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate?.(button);
  };
  button.addEventListener("click", activate);
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") activate(event);
  });
  return button;
}

function filePlusIcon() {
  return (
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M5.75 3.25h5.5l3 3v10.5h-8.5a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M11.25 3.25V6.5h3M9 9.75v4M7 11.75h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>"
  );
}

function folderPlusIcon() {
  return (
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M2.75 6.5A2.25 2.25 0 0 1 5 4.25h3l1.6 1.75H15A2.25 2.25 0 0 1 17.25 8.25v5.5A2.25 2.25 0 0 1 15 16H5a2.25 2.25 0 0 1-2.25-2.25V6.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M10 9.25v4M8 11.25h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    "</svg>"
  );
}

function fileIcon() {
  return (
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M5.75 3.25h5.5l3 3v10.5h-8.5a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M11.25 3.25V6.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>"
  );
}

function folderIcon() {
  return (
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M2.75 6.5A2.25 2.25 0 0 1 5 4.25h3l1.6 1.75H15A2.25 2.25 0 0 1 17.25 8.25v5.5A2.25 2.25 0 0 1 15 16H5a2.25 2.25 0 0 1-2.25-2.25V6.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    "</svg>"
  );
}

function openFileTreeCreateInline(state, panel, parentPath, kind, anchor) {
  if (!parentPath) {
    showFileTreeCreateFeedback(panel, "No folder", "error");
    return;
  }

  closeFileTreeCreateInline(state);

  const row = el("div", "codexpp-file-tree-create-inline");
  row.dataset.codexppFileTreeCreate = "true";
  row.dataset.kind = kind;
  row.setAttribute("role", "treeitem");
  row.setAttribute(
    "aria-label",
    kind === "folder" ? "Create folder" : "Create file",
  );

  const icon = el("span", "codexpp-file-tree-create-inline-icon");

  const input = document.createElement("input");
  input.className = "codexpp-file-tree-create-inline-input";
  input.placeholder = kind === "folder" ? "Folder name" : "File name";
  input.spellcheck = false;
  input.autocomplete = "off";
  setFileTreeCreateInlineIcon(icon, parentPath, kind, "");

  const message = el("span", "codexpp-file-tree-create-inline-message");
  message.hidden = true;

  row.appendChild(icon);
  row.appendChild(input);
  row.appendChild(message);
  insertFileTreeCreateInlineRow(panel, row, anchor);

  const onPointerDown = (event) => {
    if (row.contains(event.target) || anchor?.contains(event.target)) return;
    if (!input.value.trim()) closeFileTreeCreateInline(state);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFileTreeCreateInline(state);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void submitFileTreeCreateItem(state, panel, parentPath, kind, input);
    }
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("input", () => {
    setFileTreeCreateInlineIcon(icon, parentPath, kind, input.value);
  });

  state.fileTreeCreateInline = {
    node: row,
    cleanup: () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      input.removeEventListener("keydown", onKeyDown);
    },
  };

  window.requestAnimationFrame(() => {
    if (state.fileTreeCreateInline?.node !== row) return;
    input.focus();
  });
}

function setFileTreeCreateInlineIcon(node, parentPath, kind, name) {
  const fallbackName = kind === "folder" ? "folder" : "file";
  const itemName = name.trim() || fallbackName;
  const item = {
    name: itemName,
    path: `${stripTrailingSlash(parentPath)}/${itemName}`,
    isDirectory: kind === "folder",
    isFile: kind === "file",
  };
  const nativeIcon = nativeFileTreeIconFor(item);
  node.replaceChildren();
  if (nativeIcon) {
    node.appendChild(nativeIcon);
  } else {
    node.innerHTML = kind === "folder" ? folderIcon() : fileIcon();
  }
}

function insertFileTreeCreateInlineRow(panel, row, anchor) {
  const folderRow = anchor?.closest(
    '[data-codexpp-file-tree-create-positioned="true"]',
  );
  if (folderRow instanceof HTMLElement) {
    row.style.paddingLeft = `${fileTreeChildIndent(panel, folderRow)}px`;
    folderRow.after(row);
    return;
  }

  const search = panel.querySelector("#workspace-directory-tree-search");
  const block =
    search instanceof HTMLInputElement
      ? findFileTreeSearchBlock(search)
      : null;
  if (block) {
    block.after(row);
  } else {
    panel.prepend(row);
  }
  row.style.paddingLeft = "18px";
}

function findFileTreeSearchBlock(search) {
  const shell = findFileTreeSearchShell(search);
  return shell?.parentElement instanceof HTMLElement
    ? shell.parentElement
    : shell;
}

function fileTreeChildIndent(panel, folderRow) {
  const panelRect = panel.getBoundingClientRect();
  const rowRect = folderRow.getBoundingClientRect();
  const existingPadding =
    parseFloat(window.getComputedStyle(folderRow).paddingLeft) || 0;
  const visualLeft = Math.max(0, rowRect.left - panelRect.left);
  return Math.max(18, visualLeft + existingPadding + 18);
}

async function submitFileTreeCreateItem(state, panel, parentPath, kind, input) {
  const row = input.closest(".codexpp-file-tree-create-inline");
  if (row?.dataset.pending === "true") return;

  const trimmed = input.value.trim();
  if (!trimmed) {
    setFileTreeCreateInlineMessage(input, "Missing name", "error");
    return;
  }

  if (row) row.dataset.pending = "true";
  input.disabled = true;

  const channel = kind === "folder" ? "create-folder" : "create-file";
  const response = await state.api.ipc.invoke(channel, {
    parentPath,
    name: trimmed,
  });

  if (!response?.ok) {
    if (row) delete row.dataset.pending;
    input.disabled = false;
    input.focus();
    setFileTreeCreateInlineMessage(
      input,
      response?.message || "Create failed",
      "error",
    );
    return;
  }

  const createdRow = commitFileTreeCreateInlineRow(
    state,
    panel,
    row,
    response,
    kind,
  );
  showFileTreeCreateFeedback(
    panel,
    kind === "folder" ? "Folder created" : "File created",
    "saved",
  );

  if (kind === "file" && response.path) {
    createdRow?.classList.add("is-selected");
    createdRow?.setAttribute("aria-selected", "true");
    scheduleOpenCreatedFile(state, panel, response.path);
  }
}

function commitFileTreeCreateInlineRow(state, panel, row, item, kind) {
  if (!(row instanceof HTMLElement) || !item?.path) {
    closeFileTreeCreateInline(state);
    return null;
  }

  releaseFileTreeCreateInline(state, row);

  const name = item.name || basename(item.path);
  row.className = "codexpp-file-tree-created-row";
  row.dataset.codexppFileTreeCreate = "true";
  row.dataset.codexppFileTreeCreated = "true";
  row.dataset.kind = kind;
  row.dataset.path = item.path;
  delete row.dataset.pending;
  row.title = item.path;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-label", name);

  const icon = el("span", "codexpp-file-tree-created-icon");
  setFileTreeCreatedIcon(icon, {
    name,
    path: item.path,
    isDirectory: kind === "folder",
    isFile: kind === "file",
  });

  const label = el("span", "codexpp-file-tree-created-name");
  label.textContent = name;
  row.replaceChildren(icon, label);

  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (kind !== "file") return;
    row.classList.add("is-selected");
    row.setAttribute("aria-selected", "true");
    attemptOpenCreatedFile(state, panel, item.path);
  };
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") activate(event);
  });

  scheduleCreatedFileTreeRowReconciliation(panel, row, item.path);
  return row;
}

function setFileTreeCreatedIcon(node, item) {
  const nativeIcon = nativeFileTreeIconFor(item);
  node.replaceChildren();
  if (nativeIcon) {
    node.appendChild(nativeIcon);
  } else {
    node.innerHTML = item.isDirectory ? folderIcon() : fileIcon();
  }
}

function setFileTreeCreateInlineMessage(input, text, tone) {
  const row = input.closest(".codexpp-file-tree-create-inline");
  const message = row?.querySelector(
    ".codexpp-file-tree-create-inline-message",
  );
  if (!(message instanceof HTMLElement)) return;
  message.textContent = text;
  message.dataset.tone = tone || "neutral";
  message.hidden = false;
}

function closeFileTreeCreateInline(state) {
  const inline = state?.fileTreeCreateInline;
  if (!inline) return;
  releaseFileTreeCreateInline(state, inline.node);
  inline.node?.remove();
}

function releaseFileTreeCreateInline(state, row) {
  const inline = state?.fileTreeCreateInline;
  if (!inline || inline.node !== row) return;
  inline.cleanup?.();
  state.fileTreeCreateInline = null;
}

function showFileTreeCreateFeedback(panel, text, tone) {
  const feedback = panel.querySelector(
    "[data-codexpp-file-tree-create-feedback='true']",
  );
  if (!(feedback instanceof HTMLElement)) return;

  if (feedback._codexppFileTreeTimer) {
    window.clearTimeout(feedback._codexppFileTreeTimer);
  }
  if (feedback._codexppFileTreeClearTimer) {
    window.clearTimeout(feedback._codexppFileTreeClearTimer);
  }

  feedback.textContent = text;
  feedback.dataset.tone = tone || "neutral";
  feedback.classList.remove("is-hiding");
  feedback.hidden = false;
  feedback._codexppFileTreeTimer = window.setTimeout(() => {
    feedback._codexppFileTreeTimer = null;
    feedback.classList.add("is-hiding");
    feedback._codexppFileTreeClearTimer = window.setTimeout(() => {
      feedback._codexppFileTreeClearTimer = null;
      feedback.hidden = true;
      feedback.textContent = "";
      feedback.classList.remove("is-hiding");
    }, 160);
  }, 2000);
}

function scheduleOpenCreatedFile(state, panel, filePath) {
  attemptOpenCreatedFile(state, panel, filePath);
  for (const delay of [250, 750, 1500, 3000]) {
    window.setTimeout(() => {
      if (state.disposed || state.active?.path === filePath) return;
      attemptOpenCreatedFile(state, panel, filePath);
    }, delay);
  }
}

function attemptOpenCreatedFile(state, panel, filePath) {
  void openCreatedFile(state, panel, filePath).catch((error) => {
    state.api.log.warn("file editor failed to open created file", error);
  });
}

async function openCreatedFile(state, panel, filePath) {
  if (!filePath) return false;

  if (state.active && !state.active.disposed) {
    await openFileInEditor(state.active, filePath);
    return state.active.path === filePath;
  }

  const nativeRow = findNativeFileTreeRowByPath(panel, filePath);
  if (!nativeRow) return false;
  activateNativeFileTreeRow(nativeRow);
  return true;
}

function scheduleCreatedFileTreeRowReconciliation(panel, row, filePath) {
  for (const delay of [500, 1200, 2400, 5000]) {
    window.setTimeout(() => {
      if (!row.isConnected) return;
      if (findNativeFileTreeRowByPath(panel, filePath)) row.remove();
    }, delay);
  }
}

function findNativeFileTreeRowByPath(panel, filePath) {
  const normalized = stripTrailingSlash(filePath);
  const matches = new Set([filePath, normalized, `${normalized}/`]);
  const titled = Array.from(panel.querySelectorAll("[title]"));
  for (const node of titled) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest("[data-codexpp-file-tree-create='true']")) continue;
    if (node.closest(".codexpp-file-editor-menu")) continue;
    if (node.closest(".codexpp-file-editor-breadcrumb")) continue;
    if (node.closest("[data-codexpp-file-editor]")) continue;
    if (!matches.has(node.getAttribute("title") || "")) continue;

    const row = findFileTreeRowForNode(node);
    if (!(row instanceof HTMLElement)) continue;
    if (row.closest("[data-codexpp-file-tree-create='true']")) continue;
    return row;
  }
  return null;
}

function activateNativeFileTreeRow(row) {
  const target =
    row.matches("button,[role='treeitem'],[role='button']")
      ? row
      : row.querySelector("button,[role='treeitem'],[role='button']") || row;
  const init = { bubbles: true, cancelable: true, view: window };
  target.dispatchEvent(new MouseEvent("mousedown", init));
  target.dispatchEvent(new MouseEvent("mouseup", init));
  target.dispatchEvent(new MouseEvent("click", init));
}

function findFileTreeCreateRoot(panel, state) {
  const activePath = state.active?.path;
  const sidebarRoot = findActiveSidebarProjectRoot(activePath);
  if (sidebarRoot) return sidebarRoot;

  const treeRoot = commonDirectoryRootFromTitles(panel);
  if (treeRoot) return treeRoot;

  return activePath ? dirnamePath(activePath) : null;
}

function findActiveSidebarProjectRoot(activePath) {
  const roots = Array.from(
    document.querySelectorAll("[data-app-action-sidebar-project-id]"),
  )
    .map((node) => {
      if (!(node instanceof HTMLElement)) return null;
      const root = node.getAttribute("data-app-action-sidebar-project-id");
      if (!root?.startsWith("/")) return null;
      return {
        root,
        expanded:
          node.getAttribute("data-app-action-sidebar-project-collapsed") ===
          "false",
      };
    })
    .filter(Boolean);

  if (activePath) {
    const matching = roots
      .filter((item) => pathContains(item.root, activePath))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (matching) return matching.root;
  }

  return roots.find((item) => item.expanded)?.root || roots[0]?.root || null;
}

function commonDirectoryRootFromTitles(panel) {
  const paths = Array.from(panel.querySelectorAll('[title^="/"]'))
    .filter((node) => node instanceof HTMLElement)
    .filter((node) => !node.closest(".codexpp-file-editor-menu"))
    .filter((node) => !node.closest(".codexpp-file-editor-breadcrumb"))
    .filter((node) => !node.closest("[data-codexpp-file-editor]"))
    .map((node) => node.getAttribute("title") || "")
    .filter((title) => title.startsWith("/"))
    .map((title) => {
      const path = stripTrailingSlash(title);
      return title.endsWith("/") ? path : dirnamePath(path);
    })
    .filter(Boolean);

  if (paths.length === 0) return null;
  let parts = paths[0].split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const next = path.split("/").filter(Boolean);
    let index = 0;
    while (index < parts.length && parts[index] === next[index]) index += 1;
    parts = parts.slice(0, index);
  }
  return parts.length > 0 ? `/${parts.join("/")}` : null;
}

function pathContains(parent, child) {
  const root = stripTrailingSlash(parent);
  const target = stripTrailingSlash(child);
  return target === root || target.startsWith(`${root}/`);
}

function stripTrailingSlash(filePath) {
  const value = String(filePath || "");
  if (value === "/") return value;
  return value.replace(/\/+$/, "");
}

function dirnamePath(filePath) {
  const value = stripTrailingSlash(filePath);
  const index = value.lastIndexOf("/");
  if (index <= 0) return "/";
  return value.slice(0, index);
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
  const sourcePath = pathFromReview || findActiveTabPath(panel);
  if (!sourcePath || !sourcePath.startsWith("/")) return null;

  const review =
    findReviewElement(panel, sourcePath) ||
    (pathFromReview ? null : panel.querySelector("[data-review-path]"));
  if (!(review instanceof HTMLElement)) return null;

  const host = findEditorHost(review);
  if (!(host instanceof HTMLElement)) return null;

  if (
    host.dataset.codexppFileEditorSourcePath &&
    host.dataset.codexppFileEditorSourcePath !== sourcePath
  ) {
    delete host.dataset.codexppFileEditorSourcePath;
    delete host.dataset.codexppFileEditorPathOverride;
  }

  const overridePath = host.dataset.codexppFileEditorPathOverride;
  const path =
    overridePath && overridePath.startsWith("/") ? overridePath : sourcePath;

  return { panel, path, sourcePath, review, host };
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
  target.host.dataset.codexppFileEditorSourcePath =
    target.sourcePath || target.path;

  const editor = {
    api,
    path: target.path,
    host: target.host,
    expectedMtimeMs: readResult?.mtimeMs,
    content: readResult?.ok ? readResult.content : "",
    lastSavedContent: readResult?.ok ? readResult.content : "",
    autosaveEnabled: readAutosaveEnabled(api),
    diskAutosaveEnabled: readDiskAutosaveEnabled(api),
    autosaveDelayMs: readAutosaveDelay(api),
    wrapMode: readWrapMode(api),
    saveTimer: null,
    saving: false,
    dirty: false,
    conflicted: false,
    retryDelayMs: readAutosaveDelay(api),
    retrying: false,
    statusHideTimer: null,
    statusClearTimer: null,
    menu: null,
    commentUi: null,
    pendingCommentSelection: null,
    hoveredCommentLine: null,
    nativeChrome: null,
    platformFileExplorerLabel: null,
    disposed: false,
    setAutosaveEnabled(enabled) {
      editor.autosaveEnabled = enabled;
      if (enabled && editor.dirty && !editor.conflicted) {
        scheduleAutosave(editor);
      } else if (!enabled) {
        clearSaveTimer(editor);
      }
    },
    setDiskAutosaveEnabled(enabled) {
      editor.diskAutosaveEnabled = enabled;
      if (editor.dirty && editor.autosaveEnabled && !editor.conflicted) {
        scheduleAutosave(editor);
      }
    },
    setAutosaveDelay(delayMs) {
      editor.autosaveDelayMs = clampDelay(delayMs);
      editor.retryDelayMs = editor.autosaveDelayMs;
      if (editor.dirty && editor.autosaveEnabled && !editor.conflicted) {
        scheduleAutosave(editor);
      }
    },
    setWrapMode(mode) {
      editor.wrapMode = normalizeWrapMode(mode);
      editor.api.storage.set("editor:wrapMode", editor.wrapMode);
      applyWrapMode(editor);
    },
    dispose() {
      editor.disposed = true;
      clearSaveTimer(editor);
      clearStatusHideTimer(editor);
      closeDirectoryMenu(editor);
      closeLocalCommentUi(editor);
      restoreNativeChrome(editor);
      if (editor.dirty && editor.autosaveEnabled && !editor.conflicted) {
        if (editor.diskAutosaveEnabled) {
          void saveEditor(editor, { force: false, reason: "unmount" });
        } else {
          void saveDraft(editor);
        }
      }
      editor.overlay.remove();
      target.host.style.position = previous.position;
      target.host.style.overflow = previous.overflow;
      delete target.host.dataset.codexppFileEditorHost;
      delete target.host.dataset.codexppFileEditorSourcePath;
      delete target.host.dataset.codexppFileEditorPathOverride;
    },
  };

  applyStoredDraft(editor, readResult);
  installNativeChrome(editor, target);
  editor.overlay = buildEditorOverlay(editor, readResult);
  target.host.appendChild(editor.overlay);
  return editor;
}

function buildEditorOverlay(editor, readResult) {
  const overlay = el("div", "codexpp-file-editor");
  overlay.dataset.codexppFileEditor = "true";

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

  gutter.addEventListener("mousemove", (event) => {
    const line = lineNumberFromGutterPoint(editor, event.clientY);
    if (editor.hoveredCommentLine === line) return;
    editor.hoveredCommentLine = line;
    updateGutter(editor);
  });

  gutter.addEventListener("mouseleave", () => {
    if (editor.hoveredCommentLine == null) return;
    editor.hoveredCommentLine = null;
    updateGutter(editor);
  });

  gutter.addEventListener("click", (event) => {
    const button = event.target?.closest?.(
      ".codexpp-file-editor-gutter-comment-button",
    );
    if (!button) return;
    const line = Number(button.getAttribute("data-line"));
    if (!Number.isInteger(line) || line < 1) return;
    event.preventDefault();
    event.stopPropagation();
    const pending = editor.pendingCommentSelection;
    const selection =
      pending && pending.lineEnd === line
        ? pending
        : {
            start: 0,
            end: 0,
            text: "",
            lineStart: line,
            lineEnd: line,
          };
    showLocalCommentEditor(editor, selection);
  });

  textarea.addEventListener("input", () => {
    clearPendingLocalCommentAffordance(editor);
    closeLocalCommentUi(editor);
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

  textarea.addEventListener("mouseup", (event) => {
    scheduleLocalCommentAffordance(editor);
  });

  textarea.addEventListener("keyup", (event) => {
    const selectionKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
      event.key,
    );
    if (!event.shiftKey && !selectionKey) {
      return;
    }
    scheduleLocalCommentAffordance(editor);
  });

  codePane.appendChild(highlight);
  codePane.appendChild(textarea);
  body.appendChild(gutter);
  body.appendChild(codePane);
  overlay.appendChild(body);

  applyWrapMode(editor);
  updateGutter(editor);
  updateHighlight(editor);
  hideStatus(editor);
  return overlay;
}

function updateStatusAfterInput(editor) {
  if (!editor.dirty) hideStatus(editor);
}

function installNativeChrome(editor, target) {
  const status = el("span", "codexpp-file-editor-status");
  status.hidden = true;
  editor.statusNode = status;

  const nav = findNativePathNav(target);
  if (!nav) return;

  const breadcrumb = el("div", "codexpp-file-editor-breadcrumb");
  breadcrumb.dataset.codexppFileEditorNative = "breadcrumb";
  breadcrumb.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openBreadcrumbContextMenu(editor, editor.path, event.clientX, event.clientY);
  });
  editor.breadcrumb = breadcrumb;

  const nativeOptionsButton = findNativeOptionsButton(nav);
  const optionsButton = nativeOptionsButton;
  const onOptionsClick = (event) => {
    scheduleNativeOptionsMenuInjection(editor, optionsButton);
  };
  optionsButton?.addEventListener("click", onOptionsClick);
  editor.optionsButton = optionsButton;

  const hidden = [];
  for (const child of Array.from(nav.children)) {
    if (child.dataset?.codexppFileEditorNative) continue;
    const text = (child.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    hidden.push({ node: child, display: child.style.display });
    child.style.display = "none";
  }

  nav.insertBefore(breadcrumb, nav.firstChild);
  nav.insertBefore(status, breadcrumb.nextSibling);
  editor.nativeChrome = {
    nav,
    breadcrumb,
    status,
    optionsButton,
    onOptionsClick,
    hidden,
  };
  void loadPlatformFileExplorerLabel(editor);
  updateBreadcrumb(editor);
}

function restoreNativeChrome(editor) {
  const chrome = editor.nativeChrome;
  if (!chrome) return;
  closeDirectoryMenu(editor);
  for (const item of chrome.hidden) {
    item.node.style.display = item.display;
  }
  chrome.breadcrumb.remove();
  chrome.status.remove();
  chrome.optionsButton?.removeEventListener("click", chrome.onOptionsClick);
  editor.nativeChrome = null;
  editor.breadcrumb = null;
  editor.statusNode = null;
  editor.optionsButton = null;
}

function findNativeOptionsButton(nav) {
  const candidates = Array.from(nav.children).filter(
    (child) => child instanceof HTMLElement,
  );
  return candidates.find((child) => {
    if (child.dataset?.codexppFileEditorNative) return false;
    const text = (child.textContent || "").replace(/\s+/g, " ").trim();
    const label = `${child.getAttribute("aria-label") || ""} ${child.title || ""}`;
    const isEllipsis = text === "..." || text === "…" || text === "⋯";
    return (
      (!text || isEllipsis) &&
      (child.matches("button,[role='button']") ||
        /more|menu|options|actions/i.test(label))
    );
  }) || candidates.find((child) => {
    if (child.dataset?.codexppFileEditorNative) return false;
    const text = (child.textContent || "").replace(/\s+/g, " ").trim();
    return !text && child.querySelector("svg");
  }) || null;
}

function scheduleNativeOptionsMenuInjection(editor, anchor) {
  const startedAt = Date.now();
  const tick = () => {
    if (editor.disposed || Date.now() - startedAt > 1200) return;
    if (injectLineWrapIntoNativeOptionsMenu(editor, anchor)) return;
    window.setTimeout(tick, 50);
  };
  window.setTimeout(tick, 0);
}

function injectLineWrapIntoNativeOptionsMenu(editor, anchor) {
  const menu = findNativeMenuNear(anchor);
  if (!menu || menu.querySelector("[data-codexpp-file-editor-line-wrap]")) {
    return Boolean(menu);
  }

  const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
    (item) => item instanceof HTMLElement,
  );
  const wordWrapItem = items.find((item) =>
    /\bword\s*wrap\b/i.test(item.textContent || ""),
  );
  const nativeItem = wordWrapItem || items[0];
  if (!nativeItem) return false;

  if (wordWrapItem && !wordWrapItem.dataset.codexppFileEditorWordWrapBound) {
    wordWrapItem.dataset.codexppFileEditorWordWrapBound = "true";
    wordWrapItem.addEventListener("click", () => {
      editor.setWrapMode(editor.wrapMode === "word" ? "off" : "word");
    });
  }

  const lineWrapItem = createNativeWrapMenuItem(editor, nativeItem);
  if (wordWrapItem?.nextSibling) {
    menu.insertBefore(lineWrapItem, wordWrapItem.nextSibling);
  } else {
    menu.appendChild(lineWrapItem);
  }
  return true;
}

function findNativeMenuNear(anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(
    (menu) => menu instanceof HTMLElement && !menu.closest(".codexpp-file-editor-menu"),
  );
  return menus
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      const dx =
        rect.left > anchorRect.right
          ? rect.left - anchorRect.right
          : anchorRect.left > rect.right
            ? anchorRect.left - rect.right
            : 0;
      const dy =
        rect.top > anchorRect.bottom
          ? rect.top - anchorRect.bottom
          : anchorRect.top > rect.bottom
            ? anchorRect.top - rect.bottom
            : 0;
      return { menu, distance: dx + dy };
    })
    .sort((a, b) => a.distance - b.distance)[0]?.menu || null;
}

function createNativeWrapMenuItem(editor, nativeItem) {
  const item = document.createElement("div");
  item.setAttribute("role", "menuitem");
  item.setAttribute("tabindex", "-1");
  item.setAttribute("data-codexpp-file-editor-line-wrap", "true");
  item.className = nativeItem.className;

  const row =
    nativeItem.firstElementChild?.cloneNode(false) || document.createElement("div");
  row.textContent = "";
  if (!row.className) row.className = "flex w-full items-center gap-1.5";

  const text = document.createElement("span");
  text.textContent = `${editor.wrapMode === "line" ? "✓ " : ""}Line wrap`;
  text.className = "flex-1 min-w-0 truncate";
  row.appendChild(text);
  item.appendChild(row);

  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    editor.setWrapMode(editor.wrapMode === "line" ? "off" : "line");
    item.closest('[role="menu"]')?.remove();
  });
  return item;
}

function findNativePathNav(target) {
  const root =
    target.review.closest('[role="tabpanel"]') ||
    target.host.parentElement ||
    target.panel;
  const navs = Array.from(root.querySelectorAll('nav[aria-label="File path"]'));
  return navs.find((nav) => !nav.closest("[data-codexpp-file-editor]")) || null;
}

function updateBreadcrumb(editor) {
  if (!editor.breadcrumb) return;
  editor.breadcrumb.replaceChildren();

  const crumbs = breadcrumbParts(editor.path);
  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = el("span", "codexpp-file-editor-breadcrumb-sep");
      sep.textContent = "/";
      editor.breadcrumb.appendChild(sep);
    }

    if (crumb.isFile) {
      const current = el("span", "codexpp-file-editor-breadcrumb-current");
      current.title = crumb.path;
      const label = el("span", "codexpp-file-editor-breadcrumb-label");
      label.textContent = crumb.name;
      current.appendChild(label);
      attachBreadcrumbContextMenu(editor, current, crumb.path);
      editor.breadcrumb.appendChild(current);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "codexpp-file-editor-breadcrumb-button";
    button.textContent = crumb.name;
    button.title = crumb.path;
    attachBreadcrumbContextMenu(editor, button, crumb.path);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDirectoryMenu(editor, crumb.path, button);
    });
    editor.breadcrumb.appendChild(button);
  });
}

async function loadPlatformFileExplorerLabel(editor) {
  const response = await editor.api.ipc.invoke("platform-file-explorer");
  if (editor.disposed || !response?.ok) return;
  editor.platformFileExplorerLabel = response.label || "File Manager";
}

function attachBreadcrumbContextMenu(editor, node, targetPath) {
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openBreadcrumbContextMenu(editor, targetPath, event.clientX, event.clientY);
  });
}

function openBreadcrumbContextMenu(editor, targetPath, x, y) {
  closeDirectoryMenu(editor);
  if (editor.disposed) return;

  const menu = el("div", "codexpp-file-editor-menu");
  menu.setAttribute("role", "menu");
  menu.appendChild(
    createBreadcrumbContextMenuItem("Copy path", () => {
      void copyBreadcrumbPath(editor, targetPath);
    }),
  );
  menu.appendChild(
    createBreadcrumbContextMenuItem(
      `Open in ${editor.platformFileExplorerLabel || "File Manager"}`,
      () => {
        void openBreadcrumbPathInFileExplorer(editor, targetPath);
      },
    ),
  );
  document.body.appendChild(menu);
  positionContextMenu(menu, x, y);

  const menuState = {
    node: menu,
    cleanup: () => {},
  };
  editor.menu = menuState;

  window.setTimeout(() => {
    if (editor.disposed || editor.menu !== menuState) return;
    const onPointerDown = (event) => {
      if (menu.contains(event.target)) return;
      closeDirectoryMenu(editor);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeDirectoryMenu(editor);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    menuState.cleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, 0);
}

function createBreadcrumbContextMenuItem(label, onClick) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "codexpp-file-editor-menu-item";
  row.setAttribute("role", "menuitem");

  const entry = el("span", "codexpp-file-editor-menu-entry");
  const name = el("span", "codexpp-file-editor-menu-name");
  name.textContent = label;
  entry.appendChild(name);
  row.appendChild(entry);

  row.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.();
  });

  return row;
}

async function copyBreadcrumbPath(editor, targetPath) {
  closeDirectoryMenu(editor);
  const response = await editor.api.ipc.invoke("copy-path", targetPath);
  if (editor.disposed) return;
  if (response?.ok) {
    setStatus(editor, "Copied path", "saved");
  } else {
    setStatus(editor, response?.message || "Copy failed", "error");
  }
}

async function openBreadcrumbPathInFileExplorer(editor, targetPath) {
  closeDirectoryMenu(editor);
  const response = await editor.api.ipc.invoke(
    "open-in-file-explorer",
    targetPath,
  );
  if (editor.disposed) return;
  if (!response?.ok) {
    setStatus(editor, response?.message || "Open failed", "error");
  }
}

function breadcrumbParts(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  if (parts.length === 0) return [];
  let start = Math.max(0, parts.length - 3);
  const tweaksIndex = parts.lastIndexOf("tweaks");
  if (tweaksIndex !== -1) start = tweaksIndex;

  const out = [];
  for (let i = start; i < parts.length; i += 1) {
    out.push({
      name: parts[i],
      path: `/${parts.slice(0, i + 1).join("/")}`,
      isFile: i === parts.length - 1,
    });
  }
  return out;
}

async function openDirectoryMenu(editor, dirPath, anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  closeDirectoryMenu(editor);
  if (editor.disposed) return;

  const menu = el("div", "codexpp-file-editor-menu");
  menu.setAttribute("role", "menu");
  menu.appendChild(menuMessage("Loading..."));
  document.body.appendChild(menu);
  positionDirectoryMenu(editor, menu, anchorRect);

  const menuState = {
    node: menu,
    anchorRect,
    cleanup: () => {},
  };
  editor.menu = menuState;

  window.setTimeout(() => {
    if (editor.disposed || editor.menu !== menuState) return;
    const onPointerDown = (event) => {
      if (menu.contains(event.target) || anchor.contains(event.target)) return;
      closeDirectoryMenu(editor);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeDirectoryMenu(editor);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    menuState.cleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, 0);

  const response = await editor.api.ipc.invoke("list-dir", dirPath);
  if (editor.disposed || editor.menu !== menuState) return;

  menu.replaceChildren();
  if (!response?.ok) {
    menu.appendChild(menuMessage(response?.message || "Could not read folder."));
    positionDirectoryMenu(editor, menu, anchorRect);
    return;
  }

  const entries = response.entries || [];
  if (entries.length === 0) {
    menu.appendChild(menuMessage("No files"));
    positionDirectoryMenu(editor, menu, anchorRect);
    return;
  }

  appendDirectoryItems(editor, menuState, menu, entries, 0);
  positionDirectoryMenu(editor, menu, anchorRect);
}

function appendDirectoryItems(editor, menuState, parent, entries, depth) {
  for (const item of entries) {
    parent.appendChild(createDirectoryMenuRow(editor, menuState, item, depth));
  }
}

function createDirectoryMenuRow(editor, menuState, item, depth) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "codexpp-file-editor-menu-item";
  row.setAttribute("role", "menuitem");
  row.title = item.path;
  row.style.paddingLeft = `${7 + depth * 14}px`;
  row.disabled = !item.isDirectory && !item.isFile;

  const entry = el("span", "codexpp-file-editor-menu-entry");
  const nativeIcon = nativeFileTreeIconFor(item);
  if (nativeIcon) entry.appendChild(nativeIcon);
  const name = el("span", "codexpp-file-editor-menu-name");
  name.textContent = item.isDirectory ? `${item.name}/` : item.name;
  entry.appendChild(name);
  row.appendChild(entry);

  if (item.isDirectory) {
    row.setAttribute("aria-expanded", "false");
    const hint = el("span", "codexpp-file-editor-menu-hint");
    hint.textContent = ">";
    row.appendChild(hint);
  }

  row.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.isDirectory) {
      void toggleDirectoryMenuRow(editor, menuState, row, item, depth);
    } else if (item.isFile) {
      void openFileInEditor(editor, item.path);
    }
  });

  return row;
}

async function toggleDirectoryMenuRow(editor, menuState, row, item, depth) {
  if (editor.disposed || editor.menu !== menuState) return;

  const existing = row._codexppFileEditorChildren;
  if (existing?.isConnected) {
    existing.remove();
    row._codexppFileEditorChildren = null;
    row.setAttribute("aria-expanded", "false");
    setMenuRowHint(row, ">");
    positionDirectoryMenu(editor, menuState.node, menuState.anchorRect);
    return;
  }

  if (row.dataset.loading === "true") return;
  row.dataset.loading = "true";
  setMenuRowHint(row, "...");

  const response = await editor.api.ipc.invoke("list-dir", item.path);
  delete row.dataset.loading;
  if (editor.disposed || editor.menu !== menuState || !row.isConnected) return;

  const group = el("div", "codexpp-file-editor-menu-children");
  if (!response?.ok) {
    group.appendChild(
      menuMessage(response?.message || "Could not read folder.", depth + 1),
    );
  } else if ((response.entries || []).length === 0) {
    group.appendChild(menuMessage("No files", depth + 1));
  } else {
    appendDirectoryItems(editor, menuState, group, response.entries, depth + 1);
  }

  row.after(group);
  row._codexppFileEditorChildren = group;
  row.setAttribute("aria-expanded", "true");
  setMenuRowHint(row, "v");
  positionDirectoryMenu(editor, menuState.node, menuState.anchorRect);
}

function setMenuRowHint(row, text) {
  const hint = row.querySelector(".codexpp-file-editor-menu-hint");
  if (hint) hint.textContent = text;
}

function nativeFileTreeIconFor(item) {
  const source = findNativeFileTreeIconSource(item);
  if (!source) return null;

  const icon = el("span", "codexpp-file-editor-native-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(source.cloneNode(true));
  return icon;
}

function findNativeFileTreeIconSource(item) {
  const exact = findNativeIconByPath(item?.path);
  if (exact) return exact;

  if (item?.isDirectory) {
    return findNativeFolderIconSource();
  }

  return findNativeIconByExtension(item?.name);
}

function findNativeIconByPath(filePath) {
  if (!filePath) return null;
  const rows = Array.from(document.querySelectorAll("[title]")).filter(
    (row) => row.getAttribute("title") === filePath,
  );
  for (const row of rows) {
    const icon = nativeIconFromRow(row);
    if (icon) return icon;
  }
  return null;
}

function findNativeIconByExtension(fileName) {
  const ext = extensionOf(fileName);
  if (!ext) return null;
  const rows = Array.from(document.querySelectorAll("[title]"));
  for (const row of rows) {
    const title = row.getAttribute("title") || "";
    if (!title.startsWith("/") || extensionOf(title) !== ext) continue;
    const icon = nativeIconFromRow(row);
    if (icon) return icon;
  }
  return null;
}

function findNativeFolderIconSource() {
  const folderButton = Array.from(
    document.querySelectorAll('nav[aria-label="File path"] button svg'),
  )
    .map((svg) => svg.closest("button"))
    .find((button) => {
      const label = button?.getAttribute("aria-label") || "";
      if (label) return false;
      return button?.querySelector("svg");
    });
  return folderButton?.querySelector("svg") || null;
}

function nativeIconFromRow(row) {
  if (!(row instanceof HTMLElement)) return null;
  if (
    row.closest(".codexpp-file-editor-menu") ||
    row.closest(".codexpp-file-editor-breadcrumb") ||
    row.closest("[data-codexpp-file-tree-create='true']") ||
    row.closest("[data-codexpp-file-editor]")
  ) {
    return null;
  }

  const svgs = Array.from(row.querySelectorAll("svg"));
  return (
    svgs.find((svg) => {
      const className = String(svg.getAttribute("class") || "");
      return !/chevron|rotate|transition-transform/.test(className);
    }) ||
    svgs[0] ||
    null
  );
}

function extensionOf(fileName) {
  const base = String(fileName || "").split("/").pop() || "";
  const index = base.lastIndexOf(".");
  if (index <= 0 || index === base.length - 1) return "";
  return base.slice(index + 1).toLowerCase();
}

function menuMessage(text, depth = 0) {
  const node = el("div", "codexpp-file-editor-menu-message");
  node.textContent = text;
  node.style.paddingLeft = `${8 + depth * 14}px`;
  return node;
}

function positionDirectoryMenu(editor, menu, anchorRect) {
  const width = Math.min(320, Math.max(220, window.innerWidth - 16));
  let left = anchorRect.left;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  left = Math.max(8, Math.min(left, maxLeft));
  const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  const top = Math.max(8, Math.min(anchorRect.bottom + 4, maxTop));
  menu.style.width = `${width}px`;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function positionContextMenu(menu, x, y) {
  const width = Math.min(260, Math.max(180, window.innerWidth - 16));
  menu.style.width = `${width}px`;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, maxTop))}px`;
}

function closeDirectoryMenu(editor) {
  if (!editor?.menu) return;
  editor.menu.cleanup?.();
  editor.menu.node?.remove();
  editor.menu = null;
}

function scheduleLocalCommentAffordance(editor) {
  window.setTimeout(() => {
    if (editor.disposed || !editor.textarea) return;
    const selection = readEditorSelection(editor);
    if (!selection) {
      clearPendingLocalCommentAffordance(editor);
      return;
    }
    setPendingLocalCommentAffordance(editor, selection);
  }, 0);
}

function setPendingLocalCommentAffordance(editor, selection) {
  const previous = editor.pendingCommentSelection;
  if (
    previous &&
    previous.start === selection.start &&
    previous.end === selection.end &&
    previous.lineStart === selection.lineStart &&
    previous.lineEnd === selection.lineEnd
  ) {
    return;
  }
  editor.pendingCommentSelection = selection;
  updateGutter(editor);
}

function clearPendingLocalCommentAffordance(editor) {
  if (!editor?.pendingCommentSelection) return;
  editor.pendingCommentSelection = null;
  updateGutter(editor);
}

function readEditorSelection(editor) {
  const textarea = editor.textarea;
  if (!textarea) return null;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
    return null;
  }
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const selectedText = textarea.value.slice(from, to);
  if (!selectedText.trim()) return null;

  return {
    start: from,
    end: to,
    text: selectedText,
    lineStart: lineNumberAtIndex(textarea.value, from),
    lineEnd: lineNumberAtIndex(textarea.value, Math.max(from, to - 1)),
  };
}

function lineNumberFromGutterPoint(editor, clientY) {
  if (!editor.gutter || !editor.textarea) return null;
  const rect = editor.gutter.getBoundingClientRect();
  const lineHeight = getEditorLineHeight(editor);
  const paddingTop = 14;
  const y = clientY - rect.top + editor.textarea.scrollTop - paddingTop;
  const line = Math.floor(y / lineHeight) + 1;
  const lineCount = Math.max(1, editor.textarea.value.split("\n").length);
  return Math.max(1, Math.min(line, lineCount));
}

function getEditorLineHeight(editor) {
  const value = Number.parseFloat(getComputedStyle(editor.textarea).lineHeight);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

function lineNumberAtIndex(text, index) {
  let line = 1;
  let offset = 0;
  const limit = Math.max(0, Math.min(index, text.length));
  while (offset < limit) {
    const next = text.indexOf("\n", offset);
    if (next === -1 || next >= limit) break;
    line += 1;
    offset = next + 1;
  }
  return line;
}

function showLocalCommentEditor(editor, selection) {
  closeLocalCommentUi(editor);
  if (editor.disposed || !editor.textarea) return;
  clearPendingLocalCommentAffordance(editor);

  const panel = el("div", "codexpp-file-editor-comment-panel");
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Local comment");

  const header = el("div", "codexpp-file-editor-comment-header");
  const heading = el("div", "codexpp-file-editor-comment-heading");
  const icon = el("span", "codexpp-file-editor-comment-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" class="codexpp-file-editor-comment-icon-svg">' +
    '<path d="M4.25 4.25h7.5M4.25 7.75h5.5M4.25 11.25h3.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>' +
    '<path d="M2.75 2.75h10.5v8.5H8.1L4.9 13.75v-2.5H2.75v-8.5Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>' +
    "</svg>";
  const title = el("span", "codexpp-file-editor-comment-title");
  title.textContent = "Local comment";
  heading.appendChild(icon);
  heading.appendChild(title);

  const lineLabel = el("div", "codexpp-file-editor-comment-line");
  lineLabel.textContent =
    selection.lineStart === selection.lineEnd
      ? `Comment on line R${selection.lineEnd}`
      : `Comment on lines R${selection.lineStart}-R${selection.lineEnd}`;
  header.appendChild(heading);
  header.appendChild(lineLabel);

  const body = el("div", "codexpp-file-editor-comment-body");
  const fieldWrap = el("div", "codexpp-file-editor-comment-field-wrap");
  const field = document.createElement("div");
  field.className = "codexpp-file-editor-comment-input ProseMirror";
  field.contentEditable = "true";
  field.spellcheck = true;
  field.setAttribute("role", "textbox");
  field.setAttribute("aria-label", "Comment text");
  field.setAttribute("aria-multiline", "true");
  field.setAttribute("data-placeholder", "Write a comment...");
  fieldWrap.appendChild(field);
  body.appendChild(fieldWrap);

  const actions = el("div", "codexpp-file-editor-comment-actions");
  const actionSpacer = el("div", "codexpp-file-editor-comment-actions-spacer");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "codexpp-file-editor-comment-button";
  cancel.textContent = "Cancel";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className =
    "codexpp-file-editor-comment-button codexpp-file-editor-comment-submit";
  submit.textContent = "Comment";
  actions.appendChild(actionSpacer);
  actions.appendChild(cancel);
  actions.appendChild(submit);
  body.appendChild(actions);

  panel.appendChild(header);
  panel.appendChild(body);

  editor.commentUi = { node: panel, selection };
  renderAnnotatedEditor(editor);

  const readFieldValue = () => field.textContent || "";

  cancel.addEventListener("click", (event) => {
    event.preventDefault();
    closeLocalCommentUi(editor);
    editor.textarea?.focus();
  });
  submit.addEventListener("click", (event) => {
    event.preventDefault();
    void submitLocalComment(editor, selection, readFieldValue());
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLocalCommentUi(editor);
      editor.textarea?.focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submitLocalComment(editor, selection, readFieldValue());
    }
  });

  window.requestAnimationFrame(() => field.focus());
}

function closeLocalCommentUi(editor) {
  if (!editor?.commentUi) return;
  editor.commentUi = null;
  renderAnnotatedEditor(editor);
}

async function submitLocalComment(editor, selection, comment) {
  const text = String(comment || "").trim();
  if (!text) return;

  const submitted = await submitStructuredLocalComment(editor, selection, text);
  closeLocalCommentUi(editor);
  if (submitted) {
    setStatus(editor, "Added comment", "saved");
  } else {
    setStatus(editor, "Comment bridge unavailable", "error");
  }
}

function submitStructuredLocalComment(editor, selection, text) {
  const comment = {
    type: "comment",
    content: [{ content_type: "text", text }],
    position: {
      side: "right",
      path: editor.path,
      line: selection.lineEnd,
      ...(selection.lineStart !== selection.lineEnd
        ? { start_line: selection.lineStart, start_side: "right" }
        : {}),
    },
  };

  const bridge = globalThis.__codexppFileEditorDiffCommentsBridge;
  if (bridge && typeof bridge.submit === "function") {
    return bridge.submit({ comment });
  }

  return submitStructuredLocalCommentViaDom({ comment });
}

function submitStructuredLocalCommentViaDom(payload) {
  return new Promise((resolve) => {
    const id = `file-editor-comment-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener(resultEvent, onResult);
      resolve(false);
    }, 1000);
    const resultEvent = "__codexppFileEditorSubmitDiffCommentResult";
    const onResult = (event) => {
      let result = null;
      try {
        result = JSON.parse(event.detail);
      } catch {
        return;
      }
      if (result?.id !== id) return;
      window.clearTimeout(timeout);
      window.removeEventListener(resultEvent, onResult);
      resolve(result.ok === true);
    };
    window.addEventListener(resultEvent, onResult);
    window.dispatchEvent(
      new CustomEvent("__codexppFileEditorSubmitDiffComment", {
        detail: JSON.stringify({ id, ...payload }),
      }),
    );
  });
}

async function openFileInEditor(editor, filePath) {
  closeDirectoryMenu(editor);
  if (editor.disposed || filePath === editor.path) return;

  if (editor.dirty) {
    if (editor.autosaveEnabled && !editor.diskAutosaveEnabled) {
      await saveDraft(editor);
    } else {
      const saved = await saveEditor(editor, { force: false, reason: "navigate" });
      if (!saved || editor.dirty) return;
    }
  }

  const response = await editor.api.ipc.invoke("read-file", filePath);
  if (editor.disposed) return;
  if (!response?.ok) {
    setStatus(editor, response?.message || "Could not open file.", "error");
    return;
  }

  clearSaveTimer(editor);
  editor.host.dataset.codexppFileEditorPathOverride = response.path;
  editor.path = response.path;
  editor.expectedMtimeMs = response.mtimeMs;
  editor.content = response.content;
  editor.lastSavedContent = response.content;
  editor.dirty = false;
  editor.conflicted = false;
  editor.retryDelayMs = editor.autosaveDelayMs;
  applyStoredDraft(editor, response);
  editor.textarea.value = editor.content;
  updateBreadcrumb(editor);
  updateGutter(editor);
  updateHighlight(editor);
  hideStatus(editor);
}

function updateGutter(editor) {
  if (!editor.gutter || !editor.textarea) return;
  if (editor.commentUi) {
    renderAnnotatedEditor(editor);
    return;
  }
  const lineCount = Math.max(1, editor.textarea.value.split("\n").length);
  editor.gutter.classList.remove("is-annotating");
  editor.gutter.replaceChildren();
  for (let i = 1; i <= lineCount; i += 1) {
    editor.gutter.appendChild(createGutterLine(editor, i));
  }
}

function updateHighlight(editor) {
  if (!editor.highlightCode || !editor.textarea) return;
  if (editor.commentUi) {
    renderAnnotatedEditor(editor);
    return;
  }
  editor.highlight.classList.remove("is-annotating");
  editor.gutter.classList.remove("is-annotating");
  editor.highlightCode.innerHTML = highlightSyntax(editor.textarea.value, editor.path);
  syncHighlightScroll(editor);
}

function renderAnnotatedEditor(editor) {
  if (!editor.gutter || !editor.highlight || !editor.highlightCode || !editor.textarea) {
    return;
  }
  const active = editor.commentUi;
  if (!active) {
    editor.highlight.classList.remove("is-annotating");
    editor.gutter.classList.remove("is-annotating");
    updateGutter(editor);
    updateHighlight(editor);
    return;
  }

  const lines = editor.textarea.value.split("\n");
  const insertAfter = Math.max(
    1,
    Math.min(active.selection.lineEnd, Math.max(1, lines.length)),
  );
  editor.highlight.classList.add("is-annotating");
  editor.gutter.classList.add("is-annotating");
  editor.highlightCode.replaceChildren();
  editor.gutter.replaceChildren();

  for (let index = 0; index < Math.max(1, lines.length); index += 1) {
    const lineNumber = index + 1;
    const line = document.createElement("span");
    line.className = "codexpp-file-editor-line";
    line.innerHTML = highlightSyntax(lines[index] ?? "", editor.path) || " ";
    editor.highlightCode.appendChild(line);

    const gutterLine = document.createElement("span");
    gutterLine.className = "codexpp-file-editor-gutter-line";
    gutterLine.textContent = String(lineNumber);
    editor.gutter.appendChild(gutterLine);

    if (lineNumber === insertAfter) {
      const panel = active.node;
      panel.remove();
      editor.highlightCode.appendChild(panel);

      const spacer = document.createElement("span");
      spacer.className = "codexpp-file-editor-gutter-comment-spacer";
      spacer.setAttribute("aria-hidden", "true");
      editor.gutter.appendChild(spacer);
    }
  }
  syncHighlightScroll(editor);
}

function createGutterLine(editor, lineNumber) {
  const line = document.createElement("span");
  line.className = "codexpp-file-editor-gutter-line";
  const pending = editor.pendingCommentSelection;
  const isPendingCommentLine = pending?.lineEnd === lineNumber;
  if (editor.hoveredCommentLine === lineNumber || isPendingCommentLine) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codexpp-file-editor-gutter-comment-button";
    button.setAttribute(
      "aria-label",
      isPendingCommentLine && pending.lineStart !== pending.lineEnd
        ? `Comment on lines ${pending.lineStart}-${pending.lineEnd}`
        : `Comment on line ${lineNumber}`,
    );
    button.setAttribute("data-line", String(lineNumber));
    button.textContent = "+";
    line.appendChild(button);
  } else {
    line.textContent = String(lineNumber);
  }
  return line;
}

function syncHighlightScroll(editor) {
  if (!editor.highlight || !editor.textarea) return;
  editor.highlight.scrollTop = editor.textarea.scrollTop;
  editor.highlight.scrollLeft = editor.textarea.scrollLeft;
}

function applyWrapMode(editor) {
  const mode = normalizeWrapMode(editor.wrapMode);
  editor.wrapMode = mode;
  editor.overlay?.setAttribute("data-wrap-mode", mode);
  if (editor.textarea) {
    editor.textarea.wrap = mode === "off" ? "off" : "soft";
  }
  syncHighlightScroll(editor);
}

function scheduleAutosave(editor) {
  clearSaveTimer(editor);
  if (editor.disposed || !editor.autosaveEnabled || editor.conflicted) return;
  editor.saveTimer = window.setTimeout(() => {
    editor.saveTimer = null;
    if (editor.diskAutosaveEnabled) {
      void saveEditor(editor, { force: false, reason: "autosave" });
    } else {
      void saveDraft(editor);
    }
  }, editor.autosaveDelayMs);
}

function clearSaveTimer(editor) {
  if (editor.saveTimer) {
    window.clearTimeout(editor.saveTimer);
    editor.saveTimer = null;
  }
}

async function saveDraft(editor) {
  if (editor.disposed || !editor.textarea) return false;
  const content = editor.textarea.value;
  editor.api.storage.set(draftStorageKey(editor.path), {
    content,
    expectedMtimeMs: editor.expectedMtimeMs,
    savedAt: Date.now(),
  });
  editor.content = content;
  editor.retrying = false;
  editor.retryDelayMs = editor.autosaveDelayMs;
  return true;
}

function applyStoredDraft(editor, readResult) {
  if (!readResult?.ok) return;
  const draft = readDraft(editor.api, readResult.path);
  if (!draft) return;
  if (
    Number.isFinite(draft.expectedMtimeMs) &&
    Number.isFinite(readResult.mtimeMs) &&
    Math.abs(draft.expectedMtimeMs - readResult.mtimeMs) > 5
  ) {
    clearDraft(editor.api, readResult.path);
    return;
  }
  if (draft.content === readResult.content) {
    clearDraft(editor.api, readResult.path);
    return;
  }
  editor.content = draft.content;
  editor.dirty = true;
}

async function saveEditor(editor, options) {
  if (editor.disposed) return false;
  if (!editor.textarea) return false;
  if (editor.saving) {
    scheduleAutosave(editor);
    return false;
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
    atomic: shouldUseAtomicWrite(options?.reason),
  });

  editor.saving = false;
  if (editor.disposed) return false;

  if (response?.ok) {
    editor.expectedMtimeMs = response.mtimeMs;
    editor.lastSavedContent = content;
    editor.content = content;
    editor.dirty = false;
    editor.conflicted = false;
    editor.retryDelayMs = editor.autosaveDelayMs;
    clearDraft(editor.api, editor.path);
    if (shouldShowSaveSuccess(options?.reason)) {
      setStatus(editor, "Saved", "saved");
    } else if (editor.statusNode?.dataset.tone === "error") {
      hideStatus(editor);
    }
    return true;
  }

  if (response?.code === "conflict") {
    editor.conflicted = true;
    editor.expectedMtimeMs = response.mtimeMs;
    setStatus(editor, "Changed on disk", "error");
    return false;
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
  if (editor.autosaveEnabled && editor.diskAutosaveEnabled) {
    editor.retrying = true;
    editor.saveTimer = window.setTimeout(() => {
      editor.saveTimer = null;
      editor.retryDelayMs = Math.min(editor.retryDelayMs * 2, MAX_AUTOSAVE_DELAY_MS);
      void saveEditor(editor, { force: false, reason: "retry" });
    }, editor.retryDelayMs);
  }
  return false;
}

function shouldUseAtomicWrite(reason) {
  return reason !== "autosave" && reason !== "retry";
}

function shouldShowSaveSuccess(reason) {
  return reason !== "autosave" && reason !== "retry" && reason !== "unmount";
}

function readDraft(api, filePath) {
  const draft = api.storage.get(draftStorageKey(filePath), null);
  if (!draft || typeof draft.content !== "string") return null;
  return draft;
}

function clearDraft(api, filePath) {
  api.storage.set(draftStorageKey(filePath), null);
}

function draftStorageKey(filePath) {
  return `draft:${encodeURIComponent(String(filePath || ""))}`;
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
  clearDraft(editor.api, editor.path);
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

function readDiskAutosaveEnabled(api) {
  const value = api.storage.get("autosave:diskWrites", undefined);
  return typeof value === "boolean" ? value : false;
}

function readWrapMode(api) {
  return normalizeWrapMode(api.storage.get("editor:wrapMode", "off"));
}

function normalizeWrapMode(value) {
  return value === "word" || value === "line" ? value : "off";
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
  if (lang === "markdown") return highlightMarkdown(text);
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
  if (["md", "markdown", "mdown", "mkdn", "mdx"].includes(ext)) return "markdown";
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

function highlightMarkdown(text) {
  const lines = text.split(/(\n)/);
  let html = "";
  let atLineStart = true;
  let frontmatterOpen = false;
  let lineNumber = 0;

  for (const part of lines) {
    if (part === "\n") {
      html += part;
      atLineStart = true;
      continue;
    }

    if (!atLineStart) {
      html += highlightMarkdownInline(part);
      continue;
    }

    lineNumber += 1;
    atLineStart = false;
    html += highlightMarkdownLine(part, lineNumber, {
      get frontmatterOpen() {
        return frontmatterOpen;
      },
      set frontmatterOpen(value) {
        frontmatterOpen = value;
      },
    });
  }

  return preserveTrailingNewline(html);
}

function highlightMarkdownLine(line, lineNumber, state) {
  if (lineNumber === 1 && /^---\s*$/.test(line)) {
    state.frontmatterOpen = true;
    return span("tok-punctuation", line);
  }
  if (state.frontmatterOpen) {
    if (/^---\s*$/.test(line)) {
      state.frontmatterOpen = false;
      return span("tok-punctuation", line);
    }
    const frontmatter = line.match(/^(\s*[\w.-]+\s*:)(.*)$/);
    if (frontmatter) {
      return `${span("tok-property", frontmatter[1])}${highlightMarkdownInline(frontmatter[2])}`;
    }
    return highlightMarkdownInline(line);
  }

  const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
  if (fence) {
    return `${escapeHtml(fence[1])}${span("tok-punctuation", fence[2])}${span("tok-string", fence[3])}`;
  }

  const heading = line.match(/^(\s{0,3})(#{1,6})(\s+.*)?$/);
  if (heading) {
    return `${escapeHtml(heading[1])}${span("tok-markdown-marker", heading[2])}${span("tok-heading", heading[3] || "")}`;
  }

  const blockquote = line.match(/^(\s{0,3}>+\s?)(.*)$/);
  if (blockquote) {
    return `${span("tok-markdown-marker", blockquote[1])}${highlightMarkdownInline(blockquote[2])}`;
  }

  const list = line.match(/^(\s{0,12})([-+*]|\d+[.)])(\s+\[[ xX]\])?(\s+)(.*)$/);
  if (list) {
    return `${escapeHtml(list[1])}${span("tok-markdown-marker", list[2])}${list[3] ? span("tok-property", list[3]) : ""}${escapeHtml(list[4])}${highlightMarkdownInline(list[5])}`;
  }

  const thematic = line.match(/^(\s{0,3})([-*_])(?:\s*\2){2,}\s*$/);
  if (thematic) {
    return `${escapeHtml(thematic[1])}${span("tok-punctuation", line.slice(thematic[1].length))}`;
  }

  return highlightMarkdownInline(line);
}

function highlightMarkdownInline(text) {
  let html = "";
  let lastIndex = 0;
  const pattern = /(`+)([^`]|`(?!\1))*\1|!\[[^\]\n]*\]\([^) \n]+(?:\s+"[^"\n]*")?\)|\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"\n]*")?\)|\*\*[^*\n]+(?:\*[^*\n]+)*\*\*|__[^_\n]+(?:_[^_\n]+)*__|\*[^*\s\n][^*\n]*\*|_[^_\s\n][^_\n]*_|https?:\/\/[^\s<>()]+/g;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index || 0;
    if (index > lastIndex) html += escapeHtml(text.slice(lastIndex, index));
    html += highlightMarkdownInlineToken(token);
    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) html += escapeHtml(text.slice(lastIndex));
  return html;
}

function highlightMarkdownInlineToken(token) {
  if (token.startsWith("`")) return span("tok-inline-code", token);
  if (token.startsWith("![") || token.startsWith("[")) {
    return token.replace(
      /^(!?\[[^\]\n]*\])(\([^)]+\))$/,
      (_, label, href) => `${span("tok-link-text", label)}${span("tok-link", href)}`,
    );
  }
  if (token.startsWith("http://") || token.startsWith("https://")) {
    return span("tok-link", token);
  }
  if (token.startsWith("**") || token.startsWith("__")) return span("tok-strong", token);
  return span("tok-emphasis", token);
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
      --codexpp-file-editor-bg-fallback: #ffffff;
      --codexpp-file-editor-caret-fallback: #0169cc;
      --codexpp-file-editor-comment: #666666;
      --codexpp-file-editor-string: #008809;
      --codexpp-file-editor-keyword: #d53538;
      --codexpp-file-editor-number: #0071ea;
      --codexpp-file-editor-function: #751ed9;
      --codexpp-file-editor-property: #bd5800;
      --codexpp-file-editor-tag: #d53538;
      --codexpp-file-editor-heading: #d53538;
      --codexpp-file-editor-link: #0169cc;
      --codexpp-file-editor-inline-code: #008809;
      --codexpp-file-editor-strong: #bd5800;
      --codexpp-file-editor-emphasis: #d53538;
      position: absolute;
      inset: 0;
      z-index: 40;
      display: flex;
      min-width: 0;
      min-height: 0;
      flex-direction: column;
      background: var(
        --codexpp-file-editor-bg,
        var(
          --vscode-editor-background,
          var(
            --color-background-primary,
            var(--codexpp-file-editor-bg-fallback)
          )
        )
      );
      color: inherit;
    }

    @media (prefers-color-scheme: dark) {
      .codexpp-file-editor {
        --codexpp-file-editor-bg-fallback: #111111;
        --codexpp-file-editor-caret-fallback: #fcfcfc;
        --codexpp-file-editor-comment: #999999;
        --codexpp-file-editor-string: #85df7b;
        --codexpp-file-editor-keyword: #f67576;
        --codexpp-file-editor-number: #6dcbf4;
        --codexpp-file-editor-function: #b06dff;
        --codexpp-file-editor-property: #fa994c;
        --codexpp-file-editor-tag: #f67576;
        --codexpp-file-editor-heading: #f67576;
        --codexpp-file-editor-link: #6dcbf4;
        --codexpp-file-editor-inline-code: #85df7b;
        --codexpp-file-editor-strong: #fa994c;
        --codexpp-file-editor-emphasis: #f67576;
      }
    }

    .codexpp-file-editor-breadcrumb {
      display: flex;
      min-width: 0;
      flex: 1 1 auto;
      max-width: none;
      align-items: center;
      gap: 5px;
      overflow: hidden;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 500;
    }

    .codexpp-file-editor-breadcrumb-button {
      appearance: none;
      max-width: 180px;
      min-width: 0;
      overflow: hidden;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: color-mix(in srgb, currentColor 72%, transparent);
      cursor: default;
      font: inherit;
      padding: 2px 4px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codexpp-file-editor-breadcrumb-button:hover,
    .codexpp-file-editor-breadcrumb-button:focus-visible {
      background: color-mix(in srgb, currentColor 9%, transparent);
      color: inherit;
      outline: none;
    }

    .codexpp-file-editor-breadcrumb-sep {
      flex-shrink: 0;
      opacity: 0.38;
    }

    .codexpp-file-editor-breadcrumb-current {
      display: inline-flex;
      min-width: 0;
      max-width: 220px;
      align-items: center;
      gap: 5px;
      overflow: hidden;
      font-weight: 600;
    }

    .codexpp-file-editor-breadcrumb-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codexpp-file-editor-menu {
      position: fixed;
      z-index: 2147483647;
      max-height: min(420px, calc(100vh - 52px));
      overflow: auto;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 8px;
      background: var(--color-background-panel, #181a1f);
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.34);
      padding: 4px;
    }

    .codexpp-file-editor-menu-item {
      appearance: none;
      display: flex;
      width: 100%;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: inherit;
      cursor: default;
      font: inherit;
      font-size: 12px;
      line-height: 20px;
      padding: 4px 7px;
      text-align: left;
    }

    .codexpp-file-editor-menu-entry {
      display: flex;
      min-width: 0;
      flex: 1 1 auto;
      align-items: center;
      gap: 8px;
    }

    .codexpp-file-editor-menu-children {
      display: contents;
    }

    .codexpp-file-editor-native-icon {
      display: inline-flex;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      align-items: center;
      justify-content: center;
      color: inherit;
    }

    .codexpp-file-editor-native-icon svg {
      display: block;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .codexpp-file-editor-menu-item:hover,
    .codexpp-file-editor-menu-item:focus-visible {
      background: color-mix(in srgb, currentColor 10%, transparent);
      outline: none;
    }

    .codexpp-file-editor-menu-item:disabled {
      opacity: 0.45;
    }

    .codexpp-file-editor-menu-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codexpp-file-editor-menu-hint {
      flex-shrink: 0;
      opacity: 0.48;
    }

    .codexpp-file-editor-menu-message {
      padding: 7px 8px;
      font-size: 12px;
      opacity: 0.68;
    }

    .codexpp-file-editor-comment-panel {
      display: flex;
      position: relative;
      z-index: 5;
      flex-direction: column;
      box-sizing: border-box;
      width: calc(100% - 12px);
      margin: 8px 0 10px 6px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      border-radius: 12px;
      background: var(
        --color-token-dropdown-background,
        var(--color-background-panel, #181a1f)
      );
      box-shadow: 0 1px 2px color-mix(in srgb, #000 14%, transparent);
      color: inherit;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 20px;
      pointer-events: auto;
      white-space: normal;
    }

    .codexpp-file-editor-comment-header {
      display: flex;
      min-height: 45px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
      padding: 10px 12px;
    }

    .codexpp-file-editor-comment-heading {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 10px;
    }

    .codexpp-file-editor-comment-icon {
      display: inline-flex;
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      align-items: center;
      justify-content: center;
      border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      border-radius: 999px;
      color: color-mix(in srgb, currentColor 70%, transparent);
    }

    .codexpp-file-editor-comment-icon-svg {
      width: 16px;
      height: 16px;
    }

    .codexpp-file-editor-comment-title {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 650;
      line-height: 20px;
      color: var(--color-token-foreground, currentColor);
    }

    .codexpp-file-editor-comment-line {
      flex: 0 0 auto;
      font-size: 12px;
      line-height: 16px;
      color: color-mix(in srgb, currentColor 72%, transparent);
    }

    .codexpp-file-editor-comment-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 12px 6px;
    }

    .codexpp-file-editor-comment-field-wrap {
      position: relative;
      min-height: 32px;
    }

    .codexpp-file-editor-comment-input {
      width: 100%;
      min-height: 32px;
      max-height: 25dvh;
      overflow-y: auto;
      border: 0;
      background: transparent;
      color: var(--color-token-foreground, currentColor);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 20px;
      outline: none;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .codexpp-file-editor-comment-input:empty::before {
      content: attr(data-placeholder);
      pointer-events: none;
      color: color-mix(in srgb, currentColor 38%, transparent);
    }

    .codexpp-file-editor-comment-input:focus-visible {
      outline: none;
    }

    .codexpp-file-editor-comment-actions {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding-bottom: 0;
      color: color-mix(in srgb, currentColor 72%, transparent);
    }

    .codexpp-file-editor-comment-actions-spacer {
      min-width: 0;
      flex: 1 1 auto;
    }

    .codexpp-file-editor-comment-button {
      appearance: none;
      display: inline-flex;
      min-height: 28px;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 8px;
      background: var(--color-token-button-secondary-background, transparent);
      color: var(--color-token-foreground, currentColor);
      cursor: default;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
      padding: 3px 10px;
    }

    .codexpp-file-editor-comment-button:hover,
    .codexpp-file-editor-comment-button:focus-visible {
      background: color-mix(in srgb, currentColor 8%, transparent);
      outline: none;
    }

    .codexpp-file-editor-comment-submit {
      border-color: color-mix(in srgb, currentColor 18%, transparent);
      background: color-mix(in srgb, currentColor 9%, transparent);
    }

    .codexpp-file-tree-create-actions {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 2px;
      margin-left: auto;
      padding-right: 2px;
    }

    .codexpp-file-tree-create-button {
      appearance: none;
      display: inline-flex;
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: color-mix(in srgb, currentColor 72%, transparent);
      cursor: default;
      padding: 0;
    }

    .codexpp-file-tree-create-button svg {
      display: block;
      width: 15px;
      height: 15px;
      flex-shrink: 0;
    }

    .codexpp-file-tree-create-button:hover,
    .codexpp-file-tree-create-button:focus-visible {
      background: color-mix(in srgb, currentColor 10%, transparent);
      color: inherit;
      outline: none;
    }

    .codexpp-file-tree-row-create {
      position: absolute;
      z-index: 2;
      top: 50%;
      right: 3px;
      width: 22px;
      height: 22px;
      flex-basis: 22px;
      opacity: 0;
      transform: translateY(-50%);
      transition: opacity 120ms ease;
    }

    [data-codexpp-file-tree-create-positioned="true"]:hover > .codexpp-file-tree-row-create,
    .codexpp-file-tree-row-create:focus-visible {
      opacity: 1;
    }

    .codexpp-file-tree-create-feedback {
      margin-left: 4px;
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 11px;
      line-height: 18px;
      opacity: 1;
      transform: translateY(0);
      transition:
        opacity 150ms ease,
        transform 150ms ease;
      white-space: nowrap;
    }

    .codexpp-file-tree-create-feedback.is-hiding {
      opacity: 0;
      transform: translateY(-3px);
    }

    .codexpp-file-tree-create-feedback[data-tone="saved"] {
      color: #7edc9a;
      background: color-mix(in srgb, #7edc9a 16%, transparent);
    }

    .codexpp-file-tree-create-feedback[data-tone="error"] {
      color: #ff8d8d;
      background: color-mix(in srgb, #ff8d8d 18%, transparent);
    }

    .codexpp-file-tree-create-inline {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 7px;
      height: 28px;
      margin: 1px 8px;
      border-radius: 5px;
      color: inherit;
      padding: 0 8px 0 18px;
    }

    .codexpp-file-tree-create-inline[data-pending="true"] {
      opacity: 0.72;
    }

    .codexpp-file-tree-created-row {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 7px;
      height: 28px;
      margin: 1px 8px;
      border-radius: 5px;
      color: inherit;
      cursor: default;
      padding: 0 8px 0 18px;
    }

    .codexpp-file-tree-created-row:hover,
    .codexpp-file-tree-created-row.is-selected {
      background: color-mix(in srgb, currentColor 8%, transparent);
    }

    .codexpp-file-tree-created-icon {
      display: inline-flex;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      align-items: center;
      justify-content: center;
      color: color-mix(in srgb, currentColor 72%, transparent);
    }

    .codexpp-file-tree-created-icon svg {
      display: block;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .codexpp-file-tree-created-icon .codexpp-file-editor-native-icon {
      width: 16px;
      height: 16px;
      flex-basis: 16px;
    }

    .codexpp-file-tree-created-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codexpp-file-tree-create-inline-icon {
      display: inline-flex;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      align-items: center;
      justify-content: center;
      color: color-mix(in srgb, currentColor 72%, transparent);
    }

    .codexpp-file-tree-create-inline-icon svg {
      display: block;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .codexpp-file-tree-create-inline-icon .codexpp-file-editor-native-icon {
      width: 16px;
      height: 16px;
      flex-basis: 16px;
    }

    .codexpp-file-tree-create-inline-input {
      min-width: 0;
      height: 22px;
      flex: 1 1 auto;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 3px;
      background: var(--color-background-primary, transparent);
      color: inherit;
      font: inherit;
      font-size: 12px;
      line-height: 18px;
      outline: none;
      padding: 1px 5px;
    }

    .codexpp-file-tree-create-inline-message {
      flex: 0 1 auto;
      min-width: 0;
      color: color-mix(in srgb, currentColor 70%, transparent);
      font-size: 11px;
      line-height: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codexpp-file-tree-create-inline-message[data-tone="error"] {
      color: #ff8d8d;
    }

    .codexpp-file-editor-status {
      flex-shrink: 0;
      margin-left: 8px;
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
      white-space: normal;
      opacity: 0.45;
    }

    .codexpp-file-editor-gutter-line {
      display: block;
      min-height: 20px;
    }

    .codexpp-file-editor-gutter-comment-button {
      appearance: none;
      display: inline-flex;
      width: 18px;
      height: 18px;
      align-items: center;
      justify-content: center;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 5px;
      background: color-mix(in srgb, currentColor 8%, transparent);
      color: inherit;
      cursor: default;
      font: 600 13px/16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 0;
    }

    .codexpp-file-editor-gutter-comment-button:hover,
    .codexpp-file-editor-gutter-comment-button:focus-visible {
      background: color-mix(in srgb, #7bb7ff 20%, transparent);
      border-color: color-mix(in srgb, #7bb7ff 42%, transparent);
      outline: none;
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
      z-index: 1;
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

    .codexpp-file-editor-highlight.is-annotating code {
      display: block;
    }

    .codexpp-file-editor-highlight.is-annotating {
      z-index: 3;
    }

    .codexpp-file-editor-highlight.is-annotating .codexpp-file-editor-line {
      display: block;
      min-height: 20px;
      white-space: pre;
    }

    .codexpp-file-editor-gutter.is-annotating {
      white-space: normal;
    }

    .codexpp-file-editor-gutter-comment-spacer {
      display: block;
      height: 142px;
    }

    .codexpp-file-editor-textarea {
      position: absolute;
      inset: 0;
      z-index: 2;
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
      caret-color: var(
        --vscode-editorCursor-foreground,
        var(--color-token-text-primary, var(--codexpp-file-editor-caret-fallback))
      );
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

    .codexpp-file-editor[data-wrap-mode="word"] .codexpp-file-editor-highlight,
    .codexpp-file-editor[data-wrap-mode="word"] .codexpp-file-editor-textarea {
      overflow-x: hidden;
      overflow-wrap: normal;
      white-space: pre-wrap;
    }

    .codexpp-file-editor[data-wrap-mode="line"] .codexpp-file-editor-highlight,
    .codexpp-file-editor[data-wrap-mode="line"] .codexpp-file-editor-textarea {
      overflow-x: hidden;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .codexpp-file-editor-highlight .tok-comment {
      color: var(--codexpp-file-editor-comment);
    }

    .codexpp-file-editor-highlight .tok-string {
      color: var(--codexpp-file-editor-string);
    }

    .codexpp-file-editor-highlight .tok-keyword {
      color: var(--codexpp-file-editor-keyword);
    }

    .codexpp-file-editor-highlight .tok-number {
      color: var(--codexpp-file-editor-number);
    }

    .codexpp-file-editor-highlight .tok-function {
      color: var(--codexpp-file-editor-function);
    }

    .codexpp-file-editor-highlight .tok-property {
      color: var(--codexpp-file-editor-property);
    }

    .codexpp-file-editor-highlight .tok-tag {
      color: var(--codexpp-file-editor-tag);
    }

    .codexpp-file-editor-highlight .tok-punctuation {
      color: color-mix(in srgb, currentColor 68%, transparent);
    }

    .codexpp-file-editor-highlight .tok-markdown-marker {
      color: color-mix(in srgb, currentColor 52%, transparent);
      font-weight: 600;
    }

    .codexpp-file-editor-highlight .tok-heading {
      color: var(--codexpp-file-editor-heading);
      font-weight: 650;
    }

    .codexpp-file-editor-highlight .tok-link,
    .codexpp-file-editor-highlight .tok-link-text {
      color: var(--codexpp-file-editor-link);
    }

    .codexpp-file-editor-highlight .tok-inline-code {
      color: var(--codexpp-file-editor-inline-code);
    }

    .codexpp-file-editor-highlight .tok-strong {
      color: var(--codexpp-file-editor-strong);
      font-weight: 650;
    }

    .codexpp-file-editor-highlight .tok-emphasis {
      color: var(--codexpp-file-editor-emphasis);
      font-style: italic;
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
