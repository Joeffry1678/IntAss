const os = require('os');
const crypto = require('crypto');

const { getConfig } = require("./core/config");
const { SupabaseLicenseProvider } = require("./integrations/supabase/supabase_license_provider");

const { loadSettings, saveSettings } = require("./core/settings");

const createPythonEngine = require("./core/python_engine");

const { logToFile } = require("./core/logger");

const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WebSocket = require("ws");
globalThis.WebSocket = WebSocket;   // <- important
global.WebSocket = WebSocket;       // <- ok to keep too
let tray = null;
// ✅ Supabase (Auth + Realtime licensing)
let engineStarted = false;
let win = null;
let splash = null;
let privacyEnabled = true;

// ✅ apply to both windows
function applyCaptureProtection(enabled = privacyEnabled) {
  privacyEnabled = !!enabled;
  try { if (win && !win.isDestroyed()) win.setContentProtection(privacyEnabled); } catch {}
  try { if (splash && !splash.isDestroyed()) splash.setContentProtection(privacyEnabled); } catch {}
}


process.on("unhandledRejection", (err) => {
  logToFile("[UNHANDLED_REJECTION] " + (err?.stack || err));
});


// ✅ IPC (ONLY ONE COPY IN FILE)

// ✅ return saved resources folder (so renderer can auto-load cache after UI appears)
ipcMain.handle("resources:getSaved", async () => {
  const s = loadSettings();
  return { ok: true, path: String(s.resourcesFolder || "") };
});


// NEW: show Save dialog first, return exact file path user chose
ipcMain.handle("script:newSaveDialog", async () => {
  try {
    const { lastScriptsDir } = getLastDirs();
    const baseDir = lastScriptsDir || defaultScriptsDir();
    ensureDir(baseDir);

    const result = await dialog.showSaveDialog(win, {
      title: "Create Script",
      defaultPath: path.join(baseDir, "new_script.json"),
      filters: [{ name: "Script", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    let fp = String(result.filePath);
    if (!fp.toLowerCase().endsWith(".json")) fp += ".json";

    // remember last dir
    setLastDir("lastScriptsDir", path.dirname(fp));

    return { ok: true, path: fp };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});


// --- Audio device preference (persist last used device) ---
ipcMain.handle("audioDevice:getLast", async () => {
  const s = loadSettings();
  return { ok: true, deviceId: String(s.lastAudioDeviceId || "") };
});

ipcMain.handle("audioDevice:setLast", async (_e, { deviceId } = {}) => {
  const s = loadSettings();
  s.lastAudioDeviceId = String(deviceId || "");
  saveSettings(s);
  return { ok: true };
});


ipcMain.removeAllListeners("license:quit");
ipcMain.on("license:quit", () => {
  app.quit();
});

ipcMain.handle("privacy:get", () => {
  return { enabled: !!privacyEnabled };
});

ipcMain.on("privacy:set", (event, { enabled } = {}) => {
  const on = !!enabled;

  privacyEnabled = on;
  applyCaptureProtection(on);

  logToFile(`[PRIVACY] set => ${on ? "ON" : "OFF"}`);

  // optional: acknowledge back to renderer (nice for syncing UI)
  try {
    const w = BrowserWindow.fromWebContents(event.sender);
    w?.webContents?.send("privacy:state", { enabled: privacyEnabled });
  } catch {}
});


let deactivationPopupOpen = false;

const cfg = getConfig();
const licenseProvider = new SupabaseLicenseProvider({
  url: cfg.supabase.url,
  anonKey: cfg.supabase.anonKey,
  logger: { log: (m) => logToFile(m) }
});

const LICENSE_RECHECK_DAYS = 15;


async function evaluateLicenseGate({ forceOnline = false } = {}) {
  const mid = await getOrCreateMachineIdAsync();

  const cache = getLicenseCache();
  const now = new Date();

  // if we have cache and it’s recent, we don’t need online unless forced
  const cacheAgeOk =
    cache?.machineId === mid &&
    cache?.last_checked_at &&
    daysBetween(new Date(cache.last_checked_at), now) < LICENSE_RECHECK_DAYS;


  // If cache says active but expiry passed -> always deactivate
  if (cache?.machineId === mid && cache?.active && isExpired(cache?.expiry_date)) {
    setLicenseCache({
      ...cache,
      active: false,
      reason: "License expired",
      last_checked_at: cache.last_checked_at || now.toISOString()
    });
    return { ok: true, active: false, reason: "License expired", source: "cache" };
  }

  // If cache is valid and recent and not forced, trust it offline/online
  if (!forceOnline && cacheAgeOk) {
    return { ok: true, active: !!cache.active, reason: cache.reason || "", source: "cache" };
  }

  // Need online check (because: no cache, old cache, or forced)
  const online = await licenseProvider.isOnline(3000);

  if (online) {
	  
	let st;
	try {
	  st = await fetchLicenseStatus(mid);
	} catch (e) {
	  return { ok: false, active: false, reason: "Online check failed", error: e?.message || String(e) };
	}


    // Update cache from server result
    setLicenseCache({
      machineId: mid,
      active: !!st.active,
      reason: st.reason || "",
      expiry_date: st.license?.expiry_date || null,
      last_checked_at: now.toISOString()
    });

    return { ...st, source: "supabase" };
  }

  // Offline path:
  // Offline + already paid before -> stay active ONLY if cache says active AND last check < 15 days AND not expired
  if (cache?.machineId === mid && cache?.active && cacheAgeOk && !isExpired(cache?.expiry_date)) {
    return { ok: true, active: true, reason: "", source: "cache-offline" };
  }

  // Offline fresh install OR old cache OR inactive cache -> deactivate
  return { ok: true, active: false, reason: "Offline and no valid license cache", source: "offline" };
}

// ---- prevent "No handler registered" + allow re-activation from modal ----
try { ipcMain.removeHandler("license:activateAttempt"); } catch {}

ipcMain.handle("license:activateAttempt", async () => {
  const now = new Date();

  // Force an ONLINE check when user clicks Activate
  const st = await evaluateLicenseGate({ forceOnline: true });

  // Always refresh cache timestamp when user explicitly attempts activation
  const mid = await getOrCreateMachineIdAsync();
  setLicenseCache({
    machineId: mid,
    active: !!st.active,
    reason: st.reason || "",
    expiry_date: st.license?.expiry_date || null,
    last_checked_at: now.toISOString(),
  });

  // If active again, re-enable window + restart watch
  if (st?.ok && st?.active) {
    try { deactivationPopupOpen = false; } catch {}
    try { win?.setEnabled(true); } catch {}
    try { win?.webContents?.send("license:setActive", { active: true }); } catch {}

    try { await startLicenseWatch(mid); } catch {}

    // If your engine was stopped on deactivation (or never started), ensure it runs
    // (only if you want auto-resume)
    try {
      if (!engineStarted) {
        engineStarted = true;
        pythonEngine.start();
      }
    } catch {}

    return { ok: true, active: true, source: st.source || "supabase" };
  }

  return { ok: true, active: false, reason: st?.reason || "Still inactive", source: st?.source || "" };
});


// -------------------------
// Helpers
// -------------------------


function getLastDirs() {
  const s = loadSettings();
  return {
    lastResourcesDir: s.lastResourcesDir || "",
    lastScriptsDir: s.lastScriptsDir || "",
  };
}

function setLastDir(key, dirPath) {
  if (!dirPath) return;
  const s = loadSettings();
  s[key] = dirPath;
  saveSettings(s);
}


function didCreateLicenseRow() {
  const s = loadSettings();
  return !!s.licenseRowCreated;
}

function isFirstBootPending() {
  return !didCreateLicenseRow();
}

function setLicenseRowCreated(v = true) {
  const s = loadSettings();
  s.licenseRowCreated = !!v;
  saveSettings(s);
}

function getLicenseCache() {
  const s = loadSettings();
  return s.licenseCache || null;
}

function setLicenseCache(cacheObj) {
  const s = loadSettings();
  s.licenseCache = cacheObj || null;
  saveSettings(s);
}


function daysBetween(a, b) {
  const ms = Math.abs(+a - +b);
  return ms / (1000 * 60 * 60 * 24);
}

function isExpired(expiry_date) {
  if (!expiry_date) return false;
  return new Date(expiry_date) <= new Date();
}

async function firstBootProvisioning() {
  try {
    if (didCreateLicenseRow()) return;

    const online = await licenseProvider.isOnline(3000);
    if (!online) {
      logToFile("[LICENSE] first boot provisioning skipped (offline)");
      return;
    }

    const mid = await getOrCreateMachineIdAsync();
    const res = await licenseProvider.ensureRowExists(mid);


    if (res.ok) {
      setLicenseRowCreated(true);
      logToFile("[LICENSE] first boot provisioning complete");
    } else {
      logToFile("[LICENSE] first boot provisioning failed: " + res.error);
    }
  } catch (e) {
    logToFile("[LICENSE] first boot provisioning crashed: " + (e?.message || e));
  }
}



// ✅ BOOT TIMING (put it here)
const BOOT_T0 = Date.now();
function mark(label) {
  logToFile(`[BOOT +${((Date.now() - BOOT_T0) / 1000).toFixed(2)}s] ${label}`);
}

// -------------------------
// Asset paths (dev vs packaged)
// -------------------------
function assetPath(fileName) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', fileName)
    : path.join(__dirname, '..', 'assets', fileName);
}

function getDefaultModelsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", "models", "model-en-us")
    : path.join(__dirname, "..", "models", "model-en-us");
}

function getDefaultResourcesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "resources")
    : path.join(__dirname, "..", "resources");
}


function getEngineExe() {
  return path.join(process.resourcesPath, 'engine', 'intass_engine', 'intass_engine.exe');
}


//GET Machine ID Helpers

function machineIdPath() {
  return path.join(app.getPath('userData'), 'machine_id.txt');
}

function readCachedMachineId() {
  try {
    const p = machineIdPath();
    if (!fs.existsSync(p)) return "";
    return String(fs.readFileSync(p, 'utf8')).trim();
  } catch {
    return "";
  }
}

function writeCachedMachineId(id) {
  try {
    fs.writeFileSync(machineIdPath(), String(id), 'utf8');
  } catch {}
}


function fallbackHardwareFingerprint() {
  const cpus = os.cpus?.() || [];
  const cpuModel = cpus[0]?.model || "";

  const nics = os.networkInterfaces?.() || {};
  const macs = Object.values(nics)
    .flat()
    .filter(x => x && !x.internal && x.mac && x.mac !== "00:00:00:00:00:00")
    .map(x => x.mac)
    .sort()
    .join(",");

  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.release(),
    cpuModel,
    macs
  ].join("|");

  return crypto.createHash('sha256').update(raw).digest('hex');
}


// ---- License check (schema will be finalized later) ----
// Assumption for now: public.licenses has columns:
// - machine_id (text)
// - active (bool)
// - metadata (jsonb)
// - user_id (uuid) optional
async function fetchLicenseStatus(machineId) {
  return await licenseProvider.fetchStatus(machineId);
}

async function stopLicenseWatch() {
  return await licenseProvider.stopWatch();
}


async function startLicenseWatch(machineId) {
  return await licenseProvider.startWatch(machineId, async (reason) => {
    // ✅ mark cache inactive immediately so restart doesn't come back "active"
    const cache = getLicenseCache() || {};
    setLicenseCache({
      ...cache,
      machineId,
      active: false,
      reason: reason || "Deactivated",
      last_checked_at: new Date().toISOString(),
    });

    await showDeactivatedPopup(reason || "Deactivated");
  });
}


// -------------------------
// UI helpers
// -------------------------
function sendToRenderer(payload) {
  if (!win) return;
  win.webContents.send('from-python', payload);
}

function sendToSplash(line) {
  if (!splash || splash.isDestroyed()) return;

  const s = String(line || "");

  // ❌ HARD BLOCK: never show any machine-id-like content
  const looksLikeGuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(s);
  const looksLikeSha64 = /\b[0-9a-f]{64}\b/i.test(s);
  const hasMidWords = /machine\s*id|machineguid|fingerprint|hwid|\bid:\s*/i.test(s);

  if (looksLikeGuid || looksLikeSha64 || hasMidWords) {
    logToFile(`[SPLASH_FILTER] BLOCK(MID) :: ${s}`);
    return;
  }

  // ✅ allow only engine startup/indexing messages
  const allow =
    /"type"\s*:\s*"status"|booting|starting|initializing|knowledge|loading vosk|vosk model|vosk|kaldi|indexing|index complete|engine ready|scanning audio|audio devices loaded/i.test(s);

  if (!allow) return;

  try {
    splash.webContents.send("splash-log", s);
  } catch {}
}


function sendStatus(text, level = "info") {
  const msg = String(text || '');
  sendToRenderer({ type: 'status', text: msg, level });
  // ❌ DO NOT send to splash here anymore
}


// ---- prevent "Attempted to register a second handler" crashes ----
const SCRIPT_IPC_CHANNELS = [
  "script:newWizard",
  "script:duplicate",
  "script:stat",
  "script:open",
  "script:save",
  "script:verifyPin",
  "dialog:pickFolder",
];
for (const ch of SCRIPT_IPC_CHANNELS) {
  try { ipcMain.removeHandler(ch); } catch {}
}



// -------------------------
// Python IPC helpers
// -------------------------

function showMainAndCloseSplash() {
  try { if (win && !win.isDestroyed()) win.show(); } catch {}
  try { if (splash && !splash.isDestroyed()) splash.close(); } catch {}
}


// -------------------------
// Splash window
// -------------------------
function createSplash() {
  const pngPath = assetPath('intass.png');

  let dataUrl = '';
  try {
    const b64 = fs.readFileSync(pngPath).toString('base64');
    dataUrl = `data:image/png;base64,${b64}`;
  } catch (e) {
    logToFile(`[SPLASH] Failed reading png: ${e?.message || e}`);
    dataUrl = '';
  }

  splash = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    show: true,
    icon: assetPath('intass.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  applyCaptureProtection();

  // optional: keep splash protected as it changes state
  splash.on("show",   () => applyCaptureProtection());
  splash.on("focus",  () => applyCaptureProtection());
  splash.on("restore",() => applyCaptureProtection());


  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body{
          margin:0; background:rgba(0,0,0,0);
          display:flex; align-items:center; justify-content:center;
          height:100vh; font-family:Segoe UI, sans-serif;
        }
        .card{
          width:420px; height:280px;
          border-radius:18px;
          background:rgba(20,20,20,0.92);
          border:1px solid rgba(255,255,255,0.10);
          box-shadow: 0 10px 30px rgba(0,0,0,0.55);
          display:flex; flex-direction:column;
          align-items:center;
          padding:18px 18px 14px 18px;
          box-sizing:border-box;
          gap:10px;
        }
        img{ width:72px; height:72px; }
        .title{ color:#fff; font-weight:800; letter-spacing:1px; }
        .sub{ color:#aaa; font-size:12px; }
        .dot{
          width:10px; height:10px; border-radius:50%;
          background:#2aa3ff;
          animation:pulse 1.2s infinite;
        }
        @keyframes pulse{
          0%{ transform:scale(1); opacity:0.4;}
          50%{ transform:scale(1.7); opacity:1;}
          100%{ transform:scale(1); opacity:0.4;}
        }
        .logbox{
          width:100%;
          flex:1;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 12px;
          padding: 10px;
          box-sizing:border-box;
          overflow:auto;
          color: rgba(255,255,255,0.75);
          font-size: 11px;
          line-height: 1.4;
        }
        .logline{ margin-bottom: 6px; }
        .muted{ color: rgba(255,255,255,0.45); }
      </style>
    </head>
    <body>
      <div class="card">
        ${dataUrl ? `<img src="${dataUrl}" />` : `<div class="muted">[missing intass.png]</div>`}
        <div class="title">IntAss</div>
        <div class="sub">Starting engine…</div>
        <div class="dot"></div>

        <div class="logbox" id="logbox">
          <div class="logline muted">Waiting for engine output…</div>
        </div>
      </div>

      <script>
        const { ipcRenderer } = require('electron');
        const logbox = document.getElementById('logbox');

        function addLine(t){
          const div = document.createElement('div');
          div.className = 'logline';
          div.textContent = t;
          logbox.appendChild(div);
          logbox.scrollTop = logbox.scrollHeight;
        }

        ipcRenderer.on('splash-log', (e, line) => {
          if (!line) return;
          addLine(line);
        });
      </script>
    </body>
    </html>
  `;

  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}




// -------------------------
// Main window
// -------------------------

const { exec } = require("child_process");

function getWindowsMachineGuidAsync() {
  return new Promise((resolve) => {
    exec(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve("");
        const m = String(stdout).match(/MachineGuid\s+REG_SZ\s+([^\s\r\n]+)/i);
        resolve(m ? m[1].trim() : "");
      }
    );
  });
}

let machineIdMemo = null;

async function getOrCreateMachineIdAsync() {
  if (machineIdMemo) return machineIdMemo;

  const cached = readCachedMachineId();
  if (cached) return (machineIdMemo = cached);

  let id = "";
  if (process.platform === "win32") id = await getWindowsMachineGuidAsync();
  if (!id) id = fallbackHardwareFingerprint();

  writeCachedMachineId(id);
  machineIdMemo = id;
  return id;
}

ipcMain.handle("app:getMachineId", async () => {
  const machineId = await getOrCreateMachineIdAsync();
  return { ok: true, machineId };
});


const pythonEngine = createPythonEngine({
  app,
  logToFile,
  sendToRenderer,
  sendStatus,
  sendToSplash,              
  getDefaultModelsDir,
  getDefaultResourcesDir,
  getEngineExe, 
  applyCaptureProtection,
  firstBootProvisioning,
  evaluateLicenseGate,
  startLicenseWatch,
  getOrCreateMachineIdAsync,
  showDeactivatedPopup,
  mark,
  onEngineReady: showMainAndCloseSplash,
});

async function createWindow() {
  Menu.setApplicationMenu(null);
  try { app.setAppUserModelId("com.intass.app"); } catch {}

  mark("createWindow()");

  createSplash();
  mark("splash created");

  const ico = assetPath("intass.ico");

  win = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    roundedCorners: true,
    icon: ico,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.setSkipTaskbar(true); // ✅ removes taskbar icon

  // ✅ System tray icon
  try {
    // ✅ prevent duplicate tray icon if createWindow() runs again
    if (tray) {
      try { tray.destroy(); } catch {}
      tray = null;
    }

    const trayIcon = nativeImage.createFromPath(assetPath("intass.ico"));
    tray = new Tray(trayIcon);
    tray.setToolTip("IntAss");

    // click tray to show/focus
    tray.on("click", () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
    });

    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: "Open IntAss",
        click: () => {
          if (!win || win.isDestroyed()) return;
          win.show();
          win.focus();
        }
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ]));
  } catch (e) {
    logToFile("[TRAY] Failed: " + (e?.message || e));
  }

  mark("main window created");

  // ✅ LOAD RENDERER
  const indexPath = path.join(__dirname, "renderer.html");

  win.loadFile(indexPath).catch((e) => {
    logToFile(`[WIN] loadFile failed: ${e?.message || e}`);
  });

  mark("win.loadFile called");

  win.webContents.on("did-fail-load", (e, code, desc, url) => {
    logToFile(`[WIN] did-fail-load code=${code} desc=${desc} url=${url}`);
  });

  win.webContents.on("render-process-gone", (e, details) => {
    logToFile(`[WIN] render-process-gone: ${JSON.stringify(details)}`);
  });





  win.setBackgroundColor("#00000000");

  win.on("maximize", () => win.webContents.send("window:isMaximized", { value: true }));
  win.on("unmaximize", () => win.webContents.send("window:isMaximized", { value: false }));

  applyCaptureProtection(privacyEnabled);

  // keep it sticky (obeys toggle)
  win.on("show", () => applyCaptureProtection());
  win.on("focus", () => applyCaptureProtection());
  win.on("restore", () => applyCaptureProtection());


  win.setMenuBarVisibility(false);

 // try { win.setBackgroundMaterial('acrylic'); } catch {}

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("license:setActive", {
      active: !shouldEmulateDeactivated()
    });

    mark("renderer did-finish-load");

    const s = loadSettings();
	const v = Math.max(0.15, Math.min(1.0, Number(s.opacity ?? 1.0)));

    win.webContents.send("ui:setOpacity", { value: v });
  });


const LOG_FILE = () => path.join(app.getPath("userData"), "python.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const LOG_KEEP_FILES = 5;             // keep 5 old logs

function rotateLogIfNeeded() {
  try {
    const p = LOG_FILE();
    if (!fs.existsSync(p)) return;

    const st = fs.statSync(p);
    if (st.size <= LOG_MAX_BYTES) return;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated = path.join(app.getPath("userData"), `python.${ts}.log`);
    fs.renameSync(p, rotated);
    fs.writeFileSync(p, "", "utf8"); // new empty log
  } catch {}
}

function pruneOldLogs() {
  try {
    const dir = app.getPath("userData");
    const files = fs.readdirSync(dir)
      .filter(f => /^python\.\d{4}-\d{2}-\d{2}T/.test(f) && f.endsWith(".log"))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a,b) => b.t - a.t);

    for (const x of files.slice(LOG_KEEP_FILES)) {
      try { fs.unlinkSync(path.join(dir, x.f)); } catch {}
    }
  } catch {}
}

function enforceLogRetention() {
  rotateLogIfNeeded();
  pruneOldLogs();
}

enforceLogRetention();

try {
  sendToSplash?.("Checking license…");
  logToFile("[LICENSE] boot: firstBootProvisioning start");

  await firstBootProvisioning();

  logToFile("[LICENSE] boot: firstBootProvisioning done");
  sendToSplash?.("License provisioning done.");

  const st = await evaluateLicenseGate({ forceOnline: false });

  if (!st?.ok) {
    await showDeactivatedPopup(st?.reason || "License check failed");
    return;
  }

  logToFile(`[LICENSE] gate => ok=${st?.ok} active=${st?.active} source=${st?.source} reason=${st?.reason || ""}`);

  if (!st?.ok) {
    // “ok=false” means something broke (network/provider crash etc.)
    sendToSplash?.("License check failed.");
    await showDeactivatedPopup(st?.reason || "License check failed");
    return;
  }

  if (!st?.active) {
    sendToSplash?.("License inactive.");
    await showDeactivatedPopup(st?.reason || "Deactivated");
    return;
  }

  // ✅ active → start realtime watch + engine
  const mid = await getOrCreateMachineIdAsync();
  await startLicenseWatch(mid);

  sendToSplash?.("License OK. Starting engine…");

  // ✅ make Python cache writable in packaged apps
  try {
    const cacheDir = path.join(app.getPath("userData"), "cache", "knowledge");
    fs.mkdirSync(cacheDir, { recursive: true });
    process.env.INTASS_CACHE_DIR = cacheDir;
    logToFile(`[CACHE] INTASS_CACHE_DIR=${cacheDir}`);
  } catch (e) {
    logToFile(`[CACHE] failed to set cache dir: ${e?.message || e}`);
  }


  if (!engineStarted) {
    engineStarted = true;
    pythonEngine.start();
    mark("startPython called");
  }


} catch (e) {
  const msg = "[LICENSE] boot crash: " + (e?.message || String(e));
  logToFile(msg);
  try { sendToSplash?.("License boot error."); } catch {}
  await showDeactivatedPopup("License boot error");
  return;
}




win.on("close", () => {
  try { stopLicenseWatch(); } catch {}
  try { pythonEngine.send({ cmd: "stop" }); } catch {}
});
win.on("closed", () => {
  win = null;
  try { splash?.close(); } catch {}
  splash = null;
});




}

function shouldEmulateDeactivated() {
  // Only deactivate when explicitly set
  return String(process.env.INTASS_DEACTIVATED || "").trim() === "1";
}


async function showDeactivatedPopup(detailText = "") {
	
  if (deactivationPopupOpen) return;
  deactivationPopupOpen = true;
	 
  try { win.webContents.send("license:setActive", { active: false }); } catch {}

  if (!win || win.isDestroyed()) return;
  try { win.setEnabled(false); } catch {}
  try { win.focus(); } catch {}
  
  const machineId = await getOrCreateMachineIdAsync(); // ✅ get it here

  const modal = new BrowserWindow({
    parent: win,
    modal: true,
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  modal.on("closed", () => {
    deactivationPopupOpen = false;
    try { win?.setEnabled(true); } catch {}
  });


  const safeDetail = String(detailText || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const safeMachineId = String(machineId || "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        body{
          margin:0;
          height:100vh;
          display:flex;
          align-items:center;
          justify-content:center;
          font-family: Segoe UI, sans-serif;
          background: rgba(0,0,0,0);
        }
        .card{
          width: 380px;
          border-radius: 16px;
          background: rgba(20,20,20,0.95);
          border: 1px solid rgba(255,255,255,0.10);
          box-shadow: 0 18px 45px rgba(0,0,0,0.60);
          padding: 16px 16px 14px 16px;
          box-sizing:border-box;
          color: #fff;
        }
        .title{
          font-size: 16px;
          font-weight: 800;
          margin: 0 0 8px 0;
          letter-spacing: 0.2px;
        }
        .msg{
          font-size: 13px;
          color: rgba(255,255,255,0.80);
          line-height: 1.4;
          margin: 0 0 10px 0;
        }
        .mid{
          font-size: 12px;
          color: rgba(255,255,255,0.75);
          background: rgba(0,0,0,0.25);
          border: 1px solid rgba(255,255,255,0.08);
          padding: 10px;
          border-radius: 12px;
          margin: 0 0 12px 0;
          user-select: text;
          word-break: break-all;
        }
        .detail{
          font-size: 12px;
          color: rgba(255,255,255,0.55);
          background: rgba(0,0,0,0.25);
          border: 1px solid rgba(255,255,255,0.08);
          padding: 10px;
          border-radius: 12px;
          max-height: 70px;
          overflow: auto;
          margin: 0 0 12px 0;
          display: ${safeDetail ? "block" : "none"};
        }
        .row{
          display:flex;
          justify-content:flex-end;
          gap: 10px;
        }
        button{
          border: 0;
          outline: none;
          padding: 10px 14px;
          border-radius: 10px;
          font-weight: 700;
          cursor: pointer;
          color: white;
          background: rgba(0,120,212,0.95);
        }
        button:hover{ filter: brightness(1.1); }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="title">Your app is deactivated</div>

        <p class="msg">
          <b>Your machine ID is:</b>
        </p>
        <div class="mid">${safeMachineId}</div>

        <p class="msg">
          Please contact <b>pongapps26@gmail.com</b> to activate licensing.
        </p>



		<div class="row">
		  <button id="activate" style="background: rgba(0,180,120,0.95)">Activate</button>
		  <button id="close">Close</button>
		</div>

      </div>

		<script>
		  const { ipcRenderer } = require('electron');

		  const btnClose = document.getElementById('close');
		  const btnAct   = document.getElementById('activate');

		  const MACHINE_ID = ${JSON.stringify(machineId || "")};

		  btnClose.addEventListener('click', () => {
			ipcRenderer.send('license:quit');
		  });

		  async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

		btnAct.addEventListener('click', async () => {
		  btnAct.disabled = true;
		  btnAct.textContent = "Activating…";

		  for (let i = 0; i < 60; i++) {
			try {
			  const res = await ipcRenderer.invoke("license:activateAttempt");
			  if (res?.ok && res?.active) {
				btnAct.textContent = "Activated ✓";
				ipcRenderer.send("license:activated", { machineId: MACHINE_ID });
				setTimeout(() => window.close(), 300);
				return;
			  }
			} catch {}
			await sleep(1000);
		  }

		  btnAct.disabled = false;
		  btnAct.textContent = "Activate";
		});

		</script>

    </body>
  </html>
  `;

  modal.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  modal.once("ready-to-show", () => modal.show());
}

// ================================
// SCRIPT FILE SYSTEM (Option A)
// Anyone can open/read; editing requires PIN (renderer enforces unlock)
// Saving writes to the SAME loaded path (NO process.cwd())
// ================================

function nowIso() { return new Date().toISOString(); }
function makeSaltB64() { return crypto.randomBytes(16).toString("base64"); }

function hashPinScrypt(pin, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  const key = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt:${key.toString("hex")}`;
}

function canWriteFile(filePath) {
  try { fs.accessSync(filePath, fs.constants.W_OK); return true; } catch { return false; }
}

function isScriptShape(obj) {
  return obj && obj.meta && obj.meta.schema === "intass_script_v1" && obj.nodes && obj.nodes.start;
}

function makeNewScriptObject(name, pin) {
  const salt = makeSaltB64();
  return {
    meta: {
      schema: "intass_script_v1",
      name: String(name || "New Script"),
      created_at: nowIso(),
      updated_at: nowIso(),
      pin_salt: `base64:${salt}`,
      pin_hash: hashPinScrypt(pin, salt),
    },
    nodes: {
      start: { say: "Hi! How can I help you?", listen_for: [], routes: {} }
    }
  };
}


// Folder picker (for shared drive wizard)
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose Folder",
    properties: ["openDirectory"]
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, folderPath: r.filePaths[0] };
});


// OPEN (dialog)

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function sanitizeFileName(name) {
  return String(name || "new_script")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "new_script";
}
function defaultScriptsDir() {
  const dir = path.join(app.getPath("userData"), "scripts");
  ensureDir(dir);
  return dir;
}

// NEW (wizard) - no dialogs unless shared folder picker is needed in renderer
ipcMain.handle("script:newWizard", async (_e, args) => {
  const name = String(args?.name || "New Script").trim();
  const pin  = String(args?.pin || "").trim();

  if (!/^\d{4}$/.test(pin)) return { ok: false, error: "PIN must be exactly 4 digits" };

  try {
    // ✅ if renderer already chose an exact path, use it
    const exactPath = String(args?.path || "").trim();
    let filePath = exactPath;

    if (filePath) {
      // ensure .json
      if (!filePath.toLowerCase().endsWith(".json")) filePath += ".json";
      ensureDir(path.dirname(filePath));
      setLastDir("lastScriptsDir", path.dirname(filePath));
    } else {
      // fallback (old behavior)
      const saveMode = String(args?.saveMode || "local"); // local | shared
      const folderPath = String(args?.folderPath || "").trim();

      const baseDir = (saveMode === "shared" && folderPath)
        ? folderPath
        : defaultScriptsDir();

      ensureDir(baseDir);
      setLastDir("lastScriptsDir", baseDir);

      const fileBase = String(args?.fileBase || sanitizeFileName(name));
      filePath = path.join(baseDir, `${fileBase}.json`);
    }

    if (fs.existsSync(filePath)) {
      return { ok: false, error: "File already exists. Choose a different file name/location." };
    }

    const obj = makeNewScriptObject(name, pin);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");

    return { ok: true, path: filePath, readOnly: false, script: obj };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});



// DUPLICATE (wizard)
ipcMain.handle("script:duplicate", async (_e, args) => {
  const srcPath = String(args?.srcPath || "");
  const name = String(args?.name || "Copy").trim();
  const pin  = String(args?.pin || "").trim();
  const saveMode = String(args?.saveMode || "local");
  const folderPath = String(args?.folderPath || "").trim();
  if (!srcPath) return { ok: false, error: "Missing source path" };
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: "PIN must be exactly 4 digits" };

  try {
    const raw = fs.readFileSync(srcPath, "utf8");
    const obj = JSON.parse(raw);
    if (!isScriptShape(obj)) return { ok: false, error: "Invalid source script" };

    const baseDir = (saveMode === "shared" && folderPath) ? folderPath : defaultScriptsDir();
    ensureDir(baseDir);
    const fileBase = String(args?.fileBase || sanitizeFileName(name));
    const destPath = path.join(baseDir, `${fileBase}.json`);
    if (fs.existsSync(destPath)) return { ok: false, error: "File already exists. Choose a different name." };

    // update meta + new pin
    const newObj = JSON.parse(JSON.stringify(obj));
    const salt = makeSaltB64();
    newObj.meta = {
      ...newObj.meta,
      schema: "intass_script_v1",
      name,
      created_at: nowIso(),
      updated_at: nowIso(),
      pin_salt: `base64:${salt}`,
      pin_hash: hashPinScrypt(pin, salt),
    };
    fs.writeFileSync(destPath, JSON.stringify(newObj, null, 2), "utf8");
    return { ok: true, path: destPath, readOnly: false, script: newObj };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// STAT (exists / writable / mtime) - helps shared-drive safety
ipcMain.handle("script:stat", async (_e, args) => {
  const filePath = String(args?.path || "");
  if (!filePath) return { ok: false, error: "Missing path" };
  try {
    const st = fs.statSync(filePath);
    const readOnly = !canWriteFile(filePath);
    return { ok: true, exists: true, readOnly, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { ok: true, exists: false, readOnly: true, mtimeMs: 0 };
  }
});


ipcMain.handle("script:open", async () => {
  const { lastScriptsDir } = getLastDirs();

  const r = await dialog.showOpenDialog(win, {
    title: "Open Script",
    defaultPath: lastScriptsDir || defaultScriptsDir(),
    properties: ["openFile"],
    filters: [{ name: "Script JSON", extensions: ["json"] }]
  });

  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };

  const filePath = r.filePaths[0];

  // ✅ remember ONLY for script dialog (store the folder)
  setLastDir("lastScriptsDir", path.dirname(filePath));

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);

    if (!isScriptShape(obj)) return { ok: false, error: "Not a valid IntAss script file (schema missing)" };

    const readOnly = !canWriteFile(filePath);
    return { ok: true, path: filePath, readOnly, script: obj };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});


// VERIFY PIN
ipcMain.handle("script:verifyPin", async (_e, args) => {
  const filePath = String(args?.path || "");
  const pin = String(args?.pin || "").trim();
  if (!filePath) return { ok: false, error: "Missing path" };
  if (!/^\d{4}$/.test(pin)) return { ok: true, okPin: false };

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (!isScriptShape(obj)) return { ok: false, error: "Invalid script file" };

    const saltTag = String(obj.meta.pin_salt || "");
    const salt = saltTag.startsWith("base64:") ? saltTag.slice(7) : "";
    const expected = String(obj.meta.pin_hash || "");
    const got = hashPinScrypt(pin, salt);

    const okPin =
      expected.length === got.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));

    return { ok: true, okPin };
  } catch {
    return { ok: true, okPin: false };
  }
});

// SAVE (same loaded path)
ipcMain.handle("script:save", async (_e, args) => {
  const filePath = String(args?.path || "");
  const script = args?.script;
  const expectedMtimeMs = Number(args?.expectedMtimeMs || 0);

  if (!filePath) return { ok: false, error: "Missing path" };
  if (!script || !isScriptShape(script)) return { ok: false, error: "Invalid script payload" };

  try {
    if (!canWriteFile(filePath)) return { ok: false, error: "Read-only: no permission to write to this file" };

    // simple shared-drive safety: warn if file changed since load
    if (expectedMtimeMs > 0) {
      try {
        const st = fs.statSync(filePath);
        if (Math.abs(Number(st.mtimeMs) - expectedMtimeMs) > 5) {
          return { ok: false, conflict: true, error: "File changed by someone else since you opened it" };
        }
      } catch {}
    }

    script.meta.updated_at = nowIso();
    fs.writeFileSync(filePath, JSON.stringify(script, null, 2), "utf8");
    // return new mtime so renderer can keep tracking
    try {
      const st2 = fs.statSync(filePath);
      return { ok: true, mtimeMs: st2.mtimeMs };
    } catch {
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.on("window:resizeBy", (_e, { dx = 0, dy = 0, edge = "" } = {}) => {
  if (!win || win.isDestroyed()) return;

  const b = win.getBounds();

  const MIN_W = 820;
  const MIN_H = 560;

  let x = b.x, y = b.y, w = b.width, h = b.height;

  if (edge.includes("e")) w = Math.max(MIN_W, w + dx);
  if (edge.includes("s")) h = Math.max(MIN_H, h + dy);

  if (edge.includes("w")) {
    const nw = Math.max(MIN_W, w - dx);
    x = x + (w - nw);
    w = nw;
  }

  if (edge.includes("n")) {
    const nh = Math.max(MIN_H, h - dy);
    y = y + (h - nh);
    h = nh;
  }

  // ✅ second arg disables animation (helps a LOT)
  win.setBounds({ x, y, width: w, height: h }, false);
});


ipcMain.on("window:toggleMaximize", () => {
  if (!win || win.isDestroyed()) return;

  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});


ipcMain.on('set-opacity', (event, value) => {
  if (!win) return;

  const v = Math.max(0.15, Math.min(1.0, parseFloat(value)));

  const s = loadSettings();
  s.opacity = v;
  saveSettings(s);

  win.webContents.send('ui:setOpacity', { value: v });
});

ipcMain.on('python-cmd', (event, args) => {
  pythonEngine.send(args);
});

ipcMain.handle('assets:getUrl', async (event, fileName) => {
  const p = assetPath(String(fileName || '').trim());
  if (!fs.existsSync(p)) return { ok: false, error: 'Asset not found', path: p };
  return { ok: true, url: pathToFileURL(p).toString(), path: p };
});

ipcMain.handle('choose-resources-folder', async () => {
  const { lastResourcesDir } = getLastDirs();

  const result = await dialog.showOpenDialog(win, {
    title: 'Select Resources Folder (PDFs/PPTX)',
    defaultPath: lastResourcesDir || app.getPath("documents"),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths?.length) {
    return { ok: false, canceled: true };
  }

  const folder = result.filePaths[0];

  // ✅ remember ONLY for resources dialog
  setLastDir("lastResourcesDir", folder);

  const s = loadSettings();
  s.resourcesFolder = folder;
  saveSettings(s);

  sendStatus(`Resources selected: ${folder}`, "info");

  pythonEngine.send({ cmd: 'set_resources', path: folder });
  setTimeout(() => pythonEngine.send({ cmd: 'index_knowledge' }), 650);

  return { ok: true, path: folder };
});

ipcMain.handle('transcripts:save', async (event, content) => {
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Transcript',
      defaultPath: path.join(app.getPath('documents'), 'intass-transcript.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, String(content || ''), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('transcripts:load', async () => {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Load Transcript',
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    const fp = result.filePaths[0];
    const text = fs.readFileSync(fp, 'utf8');
    return { ok: true, path: fp, text };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});


ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:close', () => win?.close());


ipcMain.handle("license:check", async (_event, { machineId } = {}) => {
  const mid = String(machineId || "").trim() || await getOrCreateMachineIdAsync();
  return await fetchLicenseStatus(mid);
});


logToFile("[LICENSE] createWindow entered");

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

