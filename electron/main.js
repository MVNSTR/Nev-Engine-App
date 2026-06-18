const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Fixed port so the Discord OAuth redirect URL stays stable.
// Register http://localhost:47821/auth/discord/callback in the Discord portal.
const PORT = Number(process.env.PORT) || 47821;
const APP_URL = `http://localhost:${PORT}`;

// Release feed (where the installer + latest.yml are published).
const GH_OWNER = 'MVNSTR';
const GH_REPO = 'Nev-Engine-App';
const RELEASES_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`;

let serverProcess = null;
let mainWindow = null;
let splashWindow = null;
let appLaunched = false;

// Generate (once) and persist a per-install secret in the user's local data
// folder. This keeps encrypted API keys / sessions readable across restarts
// while making the encryption key unique to each machine.
function loadOrCreateSecrets() {
  const file = path.join(app.getPath('userData'), 'secret.json');
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.SESSION_SECRET && s.APP_SECRET) return s;
  } catch {}
  const s = {
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_SECRET: crypto.randomBytes(32).toString('hex')
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (e) { console.error('secret persist failed', e); }
  return s;
}

function serverEntry() {
  // asar is disabled in the build config, so the app files stay as real files
  // under resources/app — both fork() and express.static work reliably.
  return app.isPackaged
    ? path.join(app.getAppPath(), 'server.js')
    : path.join(__dirname, '..', 'server.js');
}

function startServer() {
  const secrets = loadOrCreateSecrets();
  const env = {
    ...process.env,
    PORT: String(PORT),
    BASE_URL: APP_URL,
    DISCORD_CALLBACK_URL: `${APP_URL}/auth/discord/callback`,
    OPEN_BROWSER: '0',
    NEV_DATA_DIR: app.getPath('userData'),
    ALLOW_APP_CONFIG: '1',
    ADMIN_DISCORD_IDS: process.env.ADMIN_DISCORD_IDS || '889465786408775721',
    DEFAULT_DAILY_CONVERT_LIMIT: process.env.DEFAULT_DAILY_CONVERT_LIMIT || '10',
    DEFAULT_DAILY_UPLOAD_LIMIT: process.env.DEFAULT_DAILY_UPLOAD_LIMIT || '10',
    SESSION_SECRET: secrets.SESSION_SECRET,
    APP_SECRET: secrets.APP_SECRET,
    ELECTRON_RUN_AS_NODE: '1'
  };
  serverProcess = fork(serverEntry(), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  serverProcess.stdout && serverProcess.stdout.on('data', d => console.log('[server]', String(d).trim()));
  serverProcess.stderr && serverProcess.stderr.on('data', d => console.error('[server]', String(d).trim()));
  serverProcess.on('exit', code => console.log('[server] exited', code));
}

function waitForServer(done, tries = 0) {
  const req = http.get(APP_URL, res => { res.destroy(); done(); });
  req.on('error', () => {
    if (tries > 150) return done(new Error('Server did not start in time'));
    setTimeout(() => waitForServer(done, tries + 1), 150);
  });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 580,
    frame: false,
    resizable: false,
    show: true,
    center: true,
    backgroundColor: '#070b09',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function splashStatus(data) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('updater-status', data);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#070b09',
    autoHideMenuBar: true,
    title: 'NEV Audio Engine',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(APP_URL);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });
  // Open external links (e.g. download pages) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Launch the real app (only when up to date or explicitly allowed).
function proceedToApp() {
  if (appLaunched) return;
  appLaunched = true;
  splashStatus({ type: 'starting' });
  waitForServer(err => {
    if (err) console.error(err);
    createWindow();
  });
}

function runUpdateCheck() {
  // Updates only work from a packaged build.
  if (!app.isPackaged) { proceedToApp(); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  // Optional token (only if baked at build time) for private release feeds.
  if (process.env.GH_UPDATE_TOKEN) {
    try { autoUpdater.requestHeaders = { Authorization: `token ${process.env.GH_UPDATE_TOKEN}` }; } catch {}
  }

  const current = app.getVersion();

  autoUpdater.on('checking-for-update', () => splashStatus({ type: 'checking' }));
  autoUpdater.on('update-available', info => {
    splashStatus({ type: 'available', version: current, latest: info.version });
  });
  autoUpdater.on('download-progress', p => {
    splashStatus({ type: 'progress', percent: p.percent || 0 });
  });
  autoUpdater.on('update-downloaded', () => {
    splashStatus({ type: 'downloaded' });
    setTimeout(() => { try { autoUpdater.quitAndInstall(false, true); } catch (e) { splashStatus({ type: 'error', message: String(e), allowContinue: true }); } }, 900);
  });
  autoUpdater.on('update-not-available', () => proceedToApp());
  autoUpdater.on('error', err => {
    splashStatus({ type: 'error', message: (err && err.message) ? err.message : String(err), allowContinue: true });
  });

  autoUpdater.checkForUpdates().catch(err => {
    splashStatus({ type: 'error', message: (err && err.message) ? err.message : String(err), allowContinue: true });
  });
}

ipcMain.on('updater-install', () => {
  try { autoUpdater.quitAndInstall(false, true); }
  catch (e) { splashStatus({ type: 'error', message: String(e), allowContinue: true }); }
});
ipcMain.on('updater-open-releases', () => shell.openExternal(RELEASES_URL));
ipcMain.on('updater-continue', () => proceedToApp());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || splashWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    process.env.NEV_APP_VERSION = app.getVersion();
    startServer();      // boot the local server in the background
    createSplash();     // show loading/version screen
    runUpdateCheck();    // check version, then proceed or update
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (appLaunched) createWindow(); else createSplash();
      }
    });
  });
}

function stopServer() { if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; } }
app.on('window-all-closed', () => { stopServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopServer);
