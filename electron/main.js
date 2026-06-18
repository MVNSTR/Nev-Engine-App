const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { fork } = require('child_process');

// Fixed port so the Discord OAuth redirect URL stays stable.
// Register http://localhost:47821/auth/discord/callback in the Discord portal.
const PORT = Number(process.env.PORT) || 47821;
const APP_URL = `http://localhost:${PORT}`;

let serverProcess = null;
let mainWindow = null;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#070b09',
    autoHideMenuBar: true,
    title: 'NEV Audio Engine',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(APP_URL);
  // Open external links (e.g. download pages) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    startServer();
    waitForServer(err => {
      if (err) console.error(err);
      createWindow();
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

function stopServer() { if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; } }
app.on('window-all-closed', () => { stopServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopServer);
