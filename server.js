const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_SUPER_SECRET';
const APP_SECRET = process.env.APP_SECRET || SESSION_SECRET;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_CALLBACK_URL = process.env.DISCORD_CALLBACK_URL || `${BASE_URL}/auth/discord/callback`;
const ADMIN_DISCORD_IDS = String(process.env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const IS_WIN = process.platform === 'win32';
// When packaged with pkg, __dirname points to a read-only virtual snapshot.
// Use the real folder next to the executable so data/outputs/public are writable.
const ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
// Writable data location. Inside Electron the install folder is read-only, so the
// Electron main process passes NEV_DATA_DIR (e.g. the user's AppData folder).
const DATA_ROOT = process.env.NEV_DATA_DIR || ROOT;
const DATA_DIR = path.join(DATA_ROOT, 'data');
const GLOBAL_DIR = path.join(DATA_DIR, 'global');
const USERS_DIR = path.join(DATA_DIR, 'users');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const PUBLIC_DIR = path.join(ROOT, 'public');

const GLOBAL_USERS_FILE = path.join(GLOBAL_DIR, 'users.json');
const SESSIONS_FILE = path.join(GLOBAL_DIR, 'sessions.json');
const YT_COOKIES_FILE = path.join(DATA_DIR, 'youtube-cookies.txt');
const APP_CONFIG_FILE = path.join(DATA_DIR, 'app-config.json');
// Enabled by the Electron desktop app so Discord credentials can be set from the
// Settings UI. Disabled on server/web deployments (those use env vars instead).
const ALLOW_APP_CONFIG = process.env.ALLOW_APP_CONFIG === '1';

// Central auth mode: when set, this instance runs as a CLIENT (desktop app):
// it proxies auth, identity, admin and usage/limits to the central authority
// server, while all content data (history, accounts, cookies) stays local.
// When empty, this instance IS the authority (the hosted server).
const CENTRAL_AUTH_URL = (process.env.CENTRAL_AUTH_URL || '').replace(/\/+$/, '');
const IS_CLIENT = Boolean(CENTRAL_AUTH_URL);
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const ROBLOX_LIMIT_SECONDS = 7 * 60;
const AUTO_SPLIT_SECONDS = 6 * 60;
const FILE_TTL_MS = (Number(process.env.OUTPUT_TTL_HOURS) || 2) * 60 * 60 * 1000;
const FADE_IN_SECONDS = 2.5;
const FADE_OUT_SECONDS = 3;
const DEFAULT_DESCRIPTION = 'Exclusive tracks powered by NEV.';
const DEFAULT_DAILY_CONVERT_LIMIT = Number(process.env.DEFAULT_DAILY_CONVERT_LIMIT || 10);
const DEFAULT_DAILY_UPLOAD_LIMIT = Number(process.env.DEFAULT_DAILY_UPLOAD_LIMIT || 10);
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const ASSET_RECHECK_INTERVAL_MS = 45 * 1000;
const ASSET_RECHECK_MAX_ATTEMPTS = 160;

for (const dir of [DATA_DIR, GLOBAL_DIR, USERS_DIR, UPLOAD_DIR, OUTPUT_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(GLOBAL_USERS_FILE)) fs.writeFileSync(GLOBAL_USERS_FILE, '[]');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Force browser to always fetch the latest files / prevent caching of index.html
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/outputs', express.static(OUTPUT_DIR));
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data, secure = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  if (secure) { try { fs.chmodSync(file, 0o600); } catch {} }
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 100, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; return reject(error); }
      resolve({ stdout, stderr });
    });
  });
}

// Resolve external tools. Priority: explicit env override -> ./bin next to the
// app/exe -> bare name (found on the system PATH). This lets the packaged .exe
// ship ffmpeg/ffprobe/yt-dlp/deno in a sibling "bin" folder and stay portable.
function resolveBin(name) {
  const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PATH';
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  const exe = IS_WIN ? `${name}.exe` : name;
  const local = path.join(ROOT, 'bin', exe);
  if (fs.existsSync(local)) return local;
  return name; // fall back to PATH
}
const BIN = {
  ffmpeg: resolveBin('ffmpeg'),
  ffprobe: resolveBin('ffprobe'),
  ytdlp: resolveBin('yt-dlp'),
  deno: resolveBin('deno')
};
function sanitizeId(id) { return String(id || '').replace(/[^0-9]/g, ''); }
function userDir(discordId) { return path.join(USERS_DIR, sanitizeId(discordId)); }
function userFile(discordId, name) { return path.join(userDir(discordId), name); }
function ensureUserFiles(discordId) {
  const dir = userDir(discordId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, def, secure] of [
    ['history.json', [], false], ['notes.json', [], false], ['accounts.json', [], true], ['usage.json', {}, false]
  ]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) writeJson(file, def, secure);
  }
}
function getHistory(id){ ensureUserFiles(id); return readJson(userFile(id,'history.json'), []); }
function saveHistory(id,data){ writeJson(userFile(id,'history.json'), data); }
function getNotes(id){ ensureUserFiles(id); return readJson(userFile(id,'notes.json'), []); }
function saveNotes(id,data){ writeJson(userFile(id,'notes.json'), data); }
function getAccounts(id){ ensureUserFiles(id); return readJson(userFile(id,'accounts.json'), []); }
function saveAccounts(id,data){ writeJson(userFile(id,'accounts.json'), data, true); }
function getUsage(id){ ensureUserFiles(id); return readJson(userFile(id,'usage.json'), {}); }
function saveUsage(id,data){ writeJson(userFile(id,'usage.json'), data); }
function todayKey(){ return new Date().toISOString().slice(0,10); }

function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1));
  });
  return out;
}
function setSessionCookie(res, sid) {
  const value = `${sid}.${sign(sid)}`;
  const secure = BASE_URL.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nev_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60*60*24*30}${secure}`);
}
function clearSessionCookie(res){ res.setHeader('Set-Cookie', 'nev_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function getSessionId(req) {
  const cookie = parseCookies(req).nev_session;
  if (!cookie || !cookie.includes('.')) return null;
  const [sid, sig] = cookie.split('.');
  if (sig !== sign(sid)) return null;
  return sid;
}
function readSessions(){ return readJson(SESSIONS_FILE, []); }
function saveSessions(s){ writeJson(SESSIONS_FILE, s, true); }
function readGlobalUsers(){ return readJson(GLOBAL_USERS_FILE, []); }
function saveGlobalUsers(u){ writeJson(GLOBAL_USERS_FILE, u, true); }
function isAdminId(id){ return ADMIN_DISCORD_IDS.includes(String(id)); }

function publicUser(user) {
  const now = Date.now();
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName || user.global_name || user.username,
    avatar: user.avatar || null,
    email: user.email || null,
    isAdmin: isAdminId(user.id),
    firstLoginAt: user.firstLoginAt,
    lastLoginAt: user.lastLoginAt,
    lastSeenAt: user.lastSeenAt,
    isOnline: user.lastSeenAt ? now - new Date(user.lastSeenAt).getTime() < ONLINE_WINDOW_MS : false,
    dailyConvertLimit: user.dailyConvertLimit ?? DEFAULT_DAILY_CONVERT_LIMIT,
    dailyUploadLimit: user.dailyUploadLimit ?? DEFAULT_DAILY_UPLOAD_LIMIT,
    isBlocked: Boolean(user.isBlocked)
  };
}

function usageSummary(discordId, user) {
  const usage = getUsage(discordId)[todayKey()] || { convert: 0, upload: 0 };
  const admin = isAdminId(discordId);
  const convertLimit = admin ? -1 : (user.dailyConvertLimit ?? DEFAULT_DAILY_CONVERT_LIMIT);
  const uploadLimit = admin ? -1 : (user.dailyUploadLimit ?? DEFAULT_DAILY_UPLOAD_LIMIT);
  return {
    date: todayKey(),
    convert: Number(usage.convert || 0),
    upload: Number(usage.upload || 0),
    dailyConvertLimit: convertLimit,
    dailyUploadLimit: uploadLimit,
    convertRemaining: convertLimit < 0 ? -1 : Math.max(0, convertLimit - Number(usage.convert || 0)),
    uploadRemaining: uploadLimit < 0 ? -1 : Math.max(0, uploadLimit - Number(usage.upload || 0))
  };
}

// ---- Central auth client helpers (used only when IS_CLIENT) ----
function readAuthToken(){ try{ return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8')).token || ''; }catch{ return ''; } }
function saveAuthToken(token){ writeJson(AUTH_FILE, { token, savedAt:new Date().toISOString() }, true); }
function clearAuthToken(){ try{ fs.unlinkSync(AUTH_FILE); }catch{} }
async function centralFetch(pathname, { method='GET', token, body, headers={} } = {}){
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(`${CENTRAL_AUTH_URL}${pathname}`, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try{ json = JSON.parse(text); }catch{ json = { raw:text }; }
  return { ok:r.ok, status:r.status, json };
}
function bearerSid(req){
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const val = h.slice(7).trim();
  if (!val.includes('.')) return null;
  const [s, sig] = val.split('.');
  return sign(s) === sig ? s : null;
}
let clientUserCache = { token:null, me:null, ts:0 };

async function attachUser(req, res, next) {
  if (IS_CLIENT) {
    const token = readAuthToken();
    if (!token) return next();
    if (clientUserCache.token === token && clientUserCache.me && Date.now() - clientUserCache.ts < 15000) {
      req.centralMe = clientUserCache.me; req.user = clientUserCache.me.user; req.authToken = token; return next();
    }
    try {
      const r = await centralFetch('/api/me', { token });
      if (r.ok && r.json && r.json.authenticated && r.json.user) {
        clientUserCache = { token, me:r.json, ts:Date.now() };
        req.centralMe = r.json; req.user = r.json.user; req.authToken = token;
      } else if (r.status === 401) { clearAuthToken(); clientUserCache = { token:null, me:null, ts:0 }; }
    } catch (e) { /* central offline: stay unauthenticated */ }
    return next();
  }
  const sid = getSessionId(req) || bearerSid(req);
  if (!sid) return next();
  const sessions = readSessions();
  const session = sessions.find(s => s.id === sid);
  if (!session) return next();
  const users = readGlobalUsers();
  const user = users.find(u => u.id === session.discordId);
  if (!user) return next();
  const nowIso = new Date().toISOString();
  session.lastSeenAt = nowIso;
  user.lastSeenAt = nowIso;
  saveSessions(sessions);
  saveGlobalUsers(users);
  req.user = user;
  req.sessionId = sid;
  next();
}
app.use(attachUser);
function requireAuth(req,res,next){ if(!req.user) return res.status(401).json({error:'Login required'}); if(req.user.isBlocked) return res.status(403).json({error:'Your account is blocked'}); next(); }
function requireAdmin(req,res,next){ const admin = IS_CLIENT ? Boolean(req.user && req.user.isAdmin) : Boolean(req.user && isAdminId(req.user.id)); if(!admin) return res.status(403).json({error:'Admin only'}); next(); }
// Enforce a daily limit. Authority mode checks/increments local usage; client
// mode delegates to the central server so an admin can control it globally.
async function consumeLimit(req, type){
  if (IS_CLIENT) {
    try {
      const r = await centralFetch('/api/usage/consume', { method:'POST', token:req.authToken, body:{ type } });
      if (!r.ok) return (r.json && r.json.error) || 'Daily limit reached.';
      clientUserCache = { token:null, me:null, ts:0 }; // refresh usage on next /api/me
      return null;
    } catch (e) { return 'Tidak bisa menghubungi server pusat untuk cek limit.'; }
  }
  const err = checkLimit(req, type); if (err) return err; bumpUsage(req.user.id, type); return null;
}

function maskKey(key){ if(!key) return ''; if(key.length <= 12) return '••••••••'; return `${key.slice(0,4)}••••••••${key.slice(-4)}`; }
function enc(text) {
  if (!text) return '';
  const key = crypto.createHash('sha256').update(APP_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}
function dec(payload) {
  if (!payload) return '';
  if (!String(payload).startsWith('v1:')) return payload;
  const [, ivHex, tagHex, dataHex] = String(payload).split(':');
  const key = crypto.createHash('sha256').update(APP_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex,'hex'));
  decipher.setAuthTag(Buffer.from(tagHex,'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex,'hex')), decipher.final()]).toString('utf8');
}
function publicAccount(a){ return { id:a.id, label:a.label, userId:a.userId||'', groupId:a.groupId||'', defaultDescription:a.defaultDescription||DEFAULT_DESCRIPTION, isDefault:Boolean(a.isDefault), apiKeyMasked: maskKey(dec(a.apiKeyEnc||a.apiKey||'')), createdAt:a.createdAt, updatedAt:a.updatedAt }; }

// ---- App-level (Discord) configuration, stored locally & encrypted ----
function getAppConfig(){ return readJson(APP_CONFIG_FILE, {}); }
function saveAppConfig(c){ writeJson(APP_CONFIG_FILE, c, true); }
function discordCfg(){
  const c = getAppConfig();
  const clientId = (c.discordClientId || DISCORD_CLIENT_ID || '').trim();
  let clientSecret = DISCORD_CLIENT_SECRET || '';
  if (c.discordClientSecretEnc) { try { clientSecret = dec(c.discordClientSecretEnc); } catch {} }
  return { clientId, clientSecret };
}

function sanitizeTitle(input){ return String(input||'Untitled Audio').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g,'').replace(/\s+/g,' ').slice(0,90) || 'Untitled Audio'; }
function sanitizeFileName(input){ return sanitizeTitle(input).replace(/[^\w\s.\-()[\]]/g,'').trim() || 'Untitled Audio'; }
function sanitizeRobloxName(input) {
  let name = String(input || '').trim();

  // 1. Remove file extensions if any (e.g. .mp3, .ogg, .wav, .flac)
  name = name.replace(/\.(mp3|ogg|wav|flac|m4a|aac|mp4)$/gi, '');

  // 2. Decode URL encoding if present
  try {
    name = decodeURIComponent(name);
  } catch {}

  // 3. Remove URLs, domain names, links (e.g., .com, .net, .gg, https://)
  name = name.replace(/https?:\/\/\S+/gi, '');
  name = name.replace(/\b[a-zA-Z0-9-]+\.(com|net|org|gg|ru|xyz|io|info|biz|me|cc|co|us|tk|ml|ga|gq|cf)\b/gi, '');

  // 4. Replace symbols, punctuation, underscores, dashes with space
  name = name.replace(/[_+\-/\\()\[\]{}|.,;:!@#$%\^&*~`?<>]/g, ' ');

  // 5. Compress characters repeated 3 or more times (e.g. looooove -> loove, freeeee -> free)
  name = name.replace(/([a-zA-Z])\1{2,}/g, '$1$1');

  // 6. Replace/remove known platform traces, metadata, and social media words
  const blacklistedWords = [
    // Platforms & Socials
    'discord', 'youtube', 'soundcloud', 'roblox', 'robux', 'instagram', 'facebook',
    'twitter', 'tiktok', 'twitch', 'spotify', 'telegram', 'github', 'snapchat',
    // Technical & File Info
    'download', 'downloaded', 'converter', 'extension', 'file', 'export', 'render',
    // Moderation risks
    'bypass', 'bypassed', 'unban', 'admin', 'mod', 'moderator', 'hack', 'exploit',
    'cheat', 'script', 'leak', 'leaked', 'full', 'clean', 'uncensored', 'loud',
    'earrape', 'distorted', 'bassboost', 'bass boosted', 'reverb', 'sped up',
    'slowed', 'reupload', 'nightcore', 'daycore', 'speed up', 'copyright free'
  ];
  
  // Create a regex to match these words as complete words, case-insensitive
  const blacklistRegex = new RegExp('\\b(' + blacklistedWords.join('|') + ')\\b', 'gi');
  name = name.replace(blacklistRegex, '');

  // 7. Handle numbers smartly
  // First, find any standalone numbers or number sequences
  // If there's a sequence of 3 or more digits (like years or codes: 2026, 911), remove it
  name = name.replace(/\b\d{3,}\b/g, '');
  
  // Convert 1 or 2 digit numbers to their word equivalent to avoid PII filters
  const numberWords = {
    '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
    '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine',
    '10': 'Ten', '11': 'Eleven', '12': 'Twelve', '13': 'Thirteen',
    '14': 'Fourteen', '15': 'Fifteen', '16': 'Sixteen', '17': 'Seventeen',
    '18': 'Eighteen', '19': 'Nineteen', '20': 'Twenty'
  };

  // Replace single or double digit numbers (0-20) with words
  name = name.replace(/\b(\d{1,2})\b/g, (match) => {
    return numberWords[match] || '';
  });

  // Strip any remaining lone digits or digits attached to words
  name = name.replace(/\d+/g, '');

  // 8. Keep only alphabetic characters and spaces
  name = name.replace(/[^a-zA-Z\s]/g, ' ');

  // 9. Normalize spaces
  name = name.replace(/\s+/g, ' ').trim();

  // 10. Capitalize each word properly (makes it look professional and authentic)
  name = name.split(' ').map(word => {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).filter(Boolean).join(' ');

  // 11. Fallback check:
  // If name is too short (< 4 chars), or has no vowels (likely gibberish or consonants only),
  // we select a beautiful, safe generic name from a list of Roblox-approved titles
  const hasVowels = /[aeiouyAEIOUY]/.test(name);
  if (name.length < 4 || !hasVowels) {
    const safeNames = [
      'Mystic Echoes', 'Summer Breeze', 'Neon Dreams', 'Lost Horizon', 
      'Soft Whispers', 'Ocean Wave', 'Happy Journey', 'Midnight Groove', 
      'Golden Hour', 'Ethereal Calm', 'Rhythmic Beat', 'Velocity Run', 
      'Synth Wave', 'Skyline Horizon', 'Chill Melody', 'Silent Forest', 
      'Echoing Hills', 'Future Horizon'
    ];
    let hash = 0;
    const cleanInput = String(input || '');
    for (let i = 0; i < cleanInput.length; i++) {
      hash = cleanInput.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % safeNames.length;
    name = safeNames[index];
  }

  // Roblox asset names must be 50 characters or less
  return name.slice(0, 50).trim();
}
function formatDuration(seconds){ seconds=Math.max(0,Math.round(Number(seconds)||0)); const h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=seconds%60; return h>0?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`; }
function addLog(discordId, jobId, message){ const h=getHistory(discordId); const i=h.findIndex(j=>j.id===jobId); if(i<0) return; h[i].logs = Array.isArray(h[i].logs)?h[i].logs:[]; h[i].logs.push({time:new Date().toISOString(), message}); h[i].updatedAt=new Date().toISOString(); saveHistory(discordId,h); }
function getJob(discordId, jobId){ return getHistory(discordId).find(j=>j.id===jobId)||null; }
function updateJob(discordId, jobId, patch){ const h=getHistory(discordId); const i=h.findIndex(j=>j.id===jobId); if(i<0) return null; h[i]={...h[i],...patch,updatedAt:new Date().toISOString()}; saveHistory(discordId,h); return h[i]; }
function availableJobs(discordId){ return getHistory(discordId).filter(j=>j.status==='done' && !j.filesExpired && Array.isArray(j.outputs) && j.outputs.length); }
function normalizeMediaUrl(input) {
  try {
    const parsed = new URL(String(input || '').trim());
    const host = parsed.hostname.toLowerCase();

    // youtu.be/VIDEO_ID
    if (host.includes('youtu.be')) {
      const videoId = parsed.pathname.split('/').filter(Boolean)[0];
      if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }

    // youtube.com/watch?v=VIDEO_ID&list=...&index=...
    if (host.includes('youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

      // youtube.com/shorts/VIDEO_ID
      if (parsed.pathname.startsWith('/shorts/')) {
        const shortsId = parsed.pathname.split('/').filter(Boolean)[1];
        if (shortsId) return `https://www.youtube.com/watch?v=${encodeURIComponent(shortsId)}`;
      }
    }

    return parsed.toString();
  } catch {
    return input;
  }
}

function isSupportedLink(url){
  try{
    const h=new URL(url).hostname.toLowerCase();
    return h.includes('youtube.com')||h.includes('youtu.be')||h.includes('soundcloud.com');
  }catch{
    return false;
  }
}

async function getDuration(filePath){ const {stdout}=await run(BIN.ffprobe,['-v','error','-show_entries','format=duration','-of','default=nokey=1:noprint_wrappers=1',filePath]); const d=parseFloat(stdout.trim()); return Number.isFinite(d)?d:0; }
function speedFilter(speed,amp){ return ['aresample=48000',`asetrate=${Math.round(48000*speed)}`,'aresample=48000',`volume=${amp}dB`].join(','); }
async function applyFadeToFile({inputPath,outputPath,filter}){ const tmp=`${outputPath}.fade.tmp.ogg`; if(fs.existsSync(tmp)) fs.unlinkSync(tmp); await run(BIN.ffmpeg,['-y','-i',inputPath,'-af',filter,'-vn','-c:a','libvorbis','-q:a','5',tmp]); if(fs.existsSync(outputPath)) fs.unlinkSync(outputPath); fs.renameSync(tmp,outputPath); }
async function applyEdgeFades(discordId, jobId, outputs){ if(!outputs.length) return; const sorted=outputs.slice().sort((a,b)=>a.part-b.part); if(sorted.length===1){ const p=path.join(OUTPUT_DIR,sorted[0].filename); const d=await getDuration(p); await applyFadeToFile({inputPath:p,outputPath:p,filter:`afade=t=in:st=0:d=${FADE_IN_SECONDS},afade=t=out:st=${Math.max(0,d-FADE_OUT_SECONDS)}:d=${FADE_OUT_SECONDS}`}); addLog(discordId,jobId,'Fade in/out applied.'); return;} const first=path.join(OUTPUT_DIR,sorted[0].filename); await applyFadeToFile({inputPath:first,outputPath:first,filter:`afade=t=in:st=0:d=${FADE_IN_SECONDS}`}); const last=path.join(OUTPUT_DIR,sorted[sorted.length-1].filename); const d=await getDuration(last); await applyFadeToFile({inputPath:last,outputPath:last,filter:`afade=t=out:st=${Math.max(0,d-FADE_OUT_SECONDS)}:d=${FADE_OUT_SECONDS}`}); addLog(discordId,jobId,'Edge fades applied.'); }
async function downloadAudio(discordId, url, jobId) {
  const normalized = normalizeMediaUrl(url);
  const out = path.join(UPLOAD_DIR, `${jobId}_source.%(ext)s`);
  const userCookiesPath = userFile(discordId, 'youtube-cookies.txt');
  const hasUserCookies = fs.existsSync(userCookiesPath);
  const hasGlobalCookies = fs.existsSync(YT_COOKIES_FILE);
  const cookiesPath = hasUserCookies ? userCookiesPath : (hasGlobalCookies ? YT_COOKIES_FILE : null);

  const args = [
    '--no-playlist',
    '--force-ipv4',

    '--retries',
    '5',
    '--fragment-retries',
    '5',

    '--sleep-requests',
    '1',
    '--sleep-interval',
    '1',
    '--max-sleep-interval',
    '3',

    '--js-runtimes',
    `deno:${BIN.deno}`,

    '--remote-components',
    'ejs:github',

    '-x',
    '--audio-format',
    'wav',
    '--audio-quality',
    '0',

    '-o',
    out
  ];

  if (cookiesPath) {
    args.unshift('--cookies', cookiesPath);
  }

  args.push(normalized);

  try {
    await run(BIN.ytdlp, args);
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || err);

    if (msg.includes('Sign in to confirm') || msg.includes('not a bot')) {
      throw new Error('YouTube blocked this VPS and asks for login verification. Add data/youtube-cookies.txt from your own browser, then restart Docker.');
    }

    if (msg.includes('HTTP Error 429') || msg.includes('Too Many Requests')) {
      throw new Error('YouTube rate-limited this VPS IP (HTTP 429). Try again later, use data/youtube-cookies.txt, or upload the audio file directly.');
    }

    if (msg.includes('No supported JavaScript runtime')) {
      throw new Error('yt-dlp needs Deno JavaScript runtime. Rebuild Docker using the updated Dockerfile that installs Deno.');
    }

    if (msg.includes('Signature solving failed') || msg.includes('n challenge solving failed') || msg.includes('Only images are available') || msg.includes('Requested format is not available')) {
      throw new Error('YouTube signature challenge failed. Rebuild Docker with Deno installed, then try again. If it still fails, update yt-dlp and refresh youtube-cookies.txt.');
    }

    throw err;
  }

  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => f.startsWith(`${jobId}_source.`))
    .map((f) => path.join(UPLOAD_DIR, f));

  if (!files.length) {
    throw new Error('Failed to download audio from link.');
  }

  return files[0];
}

async function convertAudio(discordId, jobId, inputPath, title, speed, amplify){ addLog(discordId,jobId,'Reading audio duration...'); const originalDuration=await getDuration(inputPath); const processedDuration=originalDuration/speed; const clean=sanitizeFileName(title); const filter=speedFilter(speed,amplify); const outputs=[]; const split=processedDuration>ROBLOX_LIMIT_SECONDS; addLog(discordId,jobId,`Duration: ${formatDuration(originalDuration)} → ${formatDuration(processedDuration)}`); if(split){ addLog(discordId,jobId,'Converting and splitting into 6-minute parts...'); const prefix=`${jobId}_part_`; await run(BIN.ffmpeg,['-y','-i',inputPath,'-filter:a',filter,'-vn','-c:a','libvorbis','-q:a','5','-f','segment','-segment_time',String(AUTO_SPLIT_SECONDS),'-reset_timestamps','1',path.join(OUTPUT_DIR,`${prefix}%03d.ogg`)]); const files=fs.readdirSync(OUTPUT_DIR).filter(f=>f.startsWith(prefix)&&f.endsWith('.ogg')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})); files.forEach((f,i)=>{ const part=i+1; const display=`NEV - ${clean} - Part ${part}.ogg`; const final=`${jobId}_${part}_${display}`; fs.renameSync(path.join(OUTPUT_DIR,f),path.join(OUTPUT_DIR,final)); outputs.push({part,filename:final,displayName:display,downloadUrl:`/outputs/${encodeURIComponent(final)}`}); }); } else { addLog(discordId,jobId,'Converting single OGG file...'); const display=`NEV - ${clean}.ogg`; const final=`${jobId}_${display}`; await run(BIN.ffmpeg,['-y','-i',inputPath,'-filter:a',filter,'-vn','-c:a','libvorbis','-q:a','5',path.join(OUTPUT_DIR,final)]); outputs.push({part:1,filename:final,displayName:display,downloadUrl:`/outputs/${encodeURIComponent(final)}`}); }
 await applyEdgeFades(discordId,jobId,outputs); return {originalDuration,processedDuration,originalDurationText:formatDuration(originalDuration),processedDurationText:formatDuration(processedDuration),outputs,split,playbackSpeed:1/speed}; }
function createJob(discordId,{title,sourceType,sourceUrl,originalName,speed,amplify}){ const id=uuidv4(); const now=new Date(); const job={id,title,sourceType,sourceUrl:sourceUrl||null,originalName:originalName||title,speedUp:Number(speed.toFixed(3)),playbackSpeed:Number((1/speed).toFixed(3)),amplifyDb:Number(amplify.toFixed(1)),status:'queued',robloxStatus:'not_started',outputs:[],songNotes:[],logs:[{time:now.toISOString(),message:'Job created.'}],filesExpired:false,expiresAt:new Date(now.getTime()+FILE_TTL_MS).toISOString(),createdAt:now.toISOString(),updatedAt:now.toISOString()}; const h=getHistory(discordId); h.unshift(job); saveHistory(discordId,h); return job; }
async function processJob(discordId, jobId, inputPath, title, speed, amplify){ try{ updateJob(discordId,jobId,{status:'processing'}); addLog(discordId,jobId,'Starting conversion...'); const result=await convertAudio(discordId,jobId,inputPath,title,speed,amplify); updateJob(discordId,jobId,{...result, originalDuration:Number(result.originalDuration.toFixed(2)), processedDuration:Number(result.processedDuration.toFixed(2)), playbackSpeed:Number(result.playbackSpeed.toFixed(3)), status:'done'}); addLog(discordId,jobId,`Conversion completed. Files and job auto-delete in ${FILE_TTL_MS/3600000} hour(s).`); }catch(e){ updateJob(discordId,jobId,{status:'failed',error:e.stderr||e.message}); addLog(discordId,jobId,`Error: ${e.stderr||e.message}`); } finally { try{ if(inputPath&&fs.existsSync(inputPath)) fs.unlinkSync(inputPath); }catch{} } }
async function processLinkJob(discordId, jobId, url, title, speed, amplify){ let input=null; try{ updateJob(discordId,jobId,{status:'processing'}); addLog(discordId,jobId,'Downloading audio from link...'); input=await downloadAudio(discordId,url,jobId); addLog(discordId,jobId,'Download completed.'); const result=await convertAudio(discordId,jobId,input,title,speed,amplify); updateJob(discordId,jobId,{...result, originalDuration:Number(result.originalDuration.toFixed(2)), processedDuration:Number(result.processedDuration.toFixed(2)), playbackSpeed:Number(result.playbackSpeed.toFixed(3)), status:'done'}); addLog(discordId,jobId,`Conversion completed. Files and job auto-delete in ${FILE_TTL_MS/3600000} hour(s).`); }catch(e){ updateJob(discordId,jobId,{status:'failed',error:e.stderr||e.message}); addLog(discordId,jobId,`Error: ${e.stderr||e.message}`); } finally { try{ if(input&&fs.existsSync(input)) fs.unlinkSync(input); }catch{} } }
function expireOldFiles(discordId){
  const h=getHistory(discordId);
  const now=Date.now();
  const kept=[];
  let changed=false;
  for(const job of h){
    const expMs = job.expiresAt ? new Date(job.expiresAt).getTime()
      : (job.createdAt ? new Date(job.createdAt).getTime()+FILE_TTL_MS : now+FILE_TTL_MS);
    const busy = job.status==='queued' || job.status==='processing';
    if(expMs<=now && !busy){
      // Generated data is only retained for FILE_TTL_MS: delete output files and drop the job record.
      if(Array.isArray(job.outputs)){
        for(const o of job.outputs){ const p=path.join(OUTPUT_DIR,o.filename); if(fs.existsSync(p)){ try{fs.unlinkSync(p)}catch{} } }
      }
      changed=true;
      continue; // do not keep the job in history
    }
    kept.push(job);
  }
  if(changed) saveHistory(discordId,kept);
}
// Sweep orphaned generated files (downloads/temp/outputs) older than the TTL. Accounts/notes/usage are untouched.
function cleanupTempDirs(){
  const now=Date.now();
  for(const dir of [OUTPUT_DIR, UPLOAD_DIR]){
    let entries=[];
    try{ entries=fs.readdirSync(dir); }catch{ continue; }
    for(const name of entries){
      const p=path.join(dir,name);
      try{
        const st=fs.statSync(p);
        if(st.isFile() && (now - st.mtimeMs) > FILE_TTL_MS){ fs.unlinkSync(p); }
      }catch{}
    }
  }
}
function bumpUsage(discordId,type){ const usage=getUsage(discordId); const day=todayKey(); usage[day]=usage[day]||{convert:0,upload:0}; usage[day][type]=(usage[day][type]||0)+1; saveUsage(discordId,usage); }
function checkLimit(req,type){ if(isAdminId(req.user.id)) return null; const u=publicUser(req.user); const usage=getUsage(req.user.id)[todayKey()]||{convert:0,upload:0}; const used=usage[type]||0; const limit=type==='convert'?u.dailyConvertLimit:u.dailyUploadLimit; if(limit>=0 && used>=limit) return `${type} daily limit reached (${used}/${limit})`; return null; }
function getCreator(account,target){ if(target==='group'){ if(!account.groupId) throw new Error('Group ID is not set for this account.'); return {groupId:String(account.groupId)}; } if(!account.userId) throw new Error('User ID is not set for this account.'); return {userId:String(account.userId)}; }
function extractOperationId(p){ return p?String(p).replace(/^operations\//,''):null; }
function extractAssetId(op){ const r=op.response||op.result||{}; return r.assetId || r.asset?.id || r.asset?.assetId || r.id || null; }
async function uploadSingle({account,filePath,displayName,description,target}){ const apiKey=dec(account.apiKeyEnc||account.apiKey||''); if(!apiKey) throw new Error('API key missing.'); const file=fs.readFileSync(filePath); if(file.length>=20*1024*1024) throw new Error('File is bigger than 20MB.'); const d=await getDuration(filePath); if(d>=ROBLOX_LIMIT_SECONDS) throw new Error('File duration is longer than 7 minutes.'); const form=new FormData(); form.append('request',JSON.stringify({assetType:'Audio',displayName:sanitizeRobloxName(displayName),description:String(description||DEFAULT_DESCRIPTION).slice(0,1000),creationContext:{creator:getCreator(account,target)}})); form.append('fileContent',new Blob([file],{type:'audio/ogg'}),path.basename(filePath)); const cr=await fetch('https://apis.roblox.com/assets/v1/assets',{method:'POST',headers:{'x-api-key':apiKey},body:form}); const text=await cr.text(); let json={}; try{json=JSON.parse(text)}catch{json={raw:text}} if(!cr.ok) throw new Error(json.errors?.[0]?.message||json.message||json.error||text||'Roblox upload failed'); const operationId=extractOperationId(json.path||json.name); if(!operationId) throw new Error('Missing operation id from Roblox.'); for(let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,3000)); const or=await fetch(`https://apis.roblox.com/assets/v1/operations/${encodeURIComponent(operationId)}`,{headers:{'x-api-key':apiKey}}); const ot=await or.text(); let oj={}; try{oj=JSON.parse(ot)}catch{oj={raw:ot}} if(!or.ok) throw new Error(oj.errors?.[0]?.message||oj.message||oj.error||ot||'Operation check failed'); if(oj.done){ if(oj.error) throw new Error(oj.error.message||JSON.stringify(oj.error)); const assetId=extractAssetId(oj); if(!assetId) throw new Error('Upload done, but assetId missing.'); return {assetId:String(assetId),operationId}; } } throw new Error('Timeout waiting for Roblox operation.'); }
async function checkPlayable(account,assetId){ const key=dec(account.apiKeyEnc||account.apiKey||''); const res=await fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${encodeURIComponent(assetId)}`,{headers:{'x-api-key':key}}); const text=await res.text().catch(()=>''); if(res.ok) return {playable:true}; const low=String(text).toLowerCase(); if(['moderation','moderated','copyright','rejected','deleted','not approved','not allowed','policy'].some(x=>low.includes(x))) return {playable:false,failed:true,reason:text}; return {playable:false,failed:false,reason:text||`HTTP ${res.status}`}; }
function savePlayableNote(discordId,job,note,description){ const notes=getNotes(discordId); const id=`${job.id}:${note.part}`; const idx=notes.findIndex(n=>n.id===id); const item={id,jobId:job.id,title:job.title,part:note.part,name:note.name,assetId:note.assetId,playbackSpeed:job.playbackSpeed,speedUp:job.speedUp,description:description||job.robloxDescription||DEFAULT_DESCRIPTION,status:'available',availableAt:note.availableAt||new Date().toISOString(),createdAt:note.createdAt||job.createdAt||new Date().toISOString()}; if(idx>=0) notes[idx]=item; else notes.unshift(item); saveNotes(discordId,notes); }
async function recheckJob(discordId,jobId,force=false){ let job=getJob(discordId,jobId); if(!job) return null; const accounts=getAccounts(discordId); const account=accounts.find(a=>a.id===job.robloxAccountId); if(!account) return job; let changed=false; const notes=[]; for(const n of job.songNotes||[]){ const note={...n}; if(note.status!=='checking'||!note.pendingAssetId){ notes.push(note); continue; } const last=note.lastCheckedAt?new Date(note.lastCheckedAt).getTime():0; if(!force && Date.now()-last<ASSET_RECHECK_INTERVAL_MS){ notes.push(note); continue; } note.checkAttempts=(note.checkAttempts||0)+1; note.lastCheckedAt=new Date().toISOString(); try{ const r=await checkPlayable(account,note.pendingAssetId); if(r.playable){ note.status='available'; note.assetId=note.pendingAssetId; note.availableAt=new Date().toISOString(); note.reason=null; } else if(r.failed){ note.status='failed'; note.reason=r.reason||'Rejected by Roblox'; } else { note.reason='Waiting for Roblox moderation / availability.'; if(note.checkAttempts>=ASSET_RECHECK_MAX_ATTEMPTS){ note.status='pending'; note.reason='Still not confirmed. Use Mark Playable if it works in Roblox.'; } } }catch(e){ note.reason='Unable to check automatically.'; } changed=true; notes.push(note); }
 if(changed){ const hasA=notes.some(n=>n.status==='available'), hasF=notes.some(n=>n.status==='failed'), hasC=notes.some(n=>['checking','pending'].includes(n.status)); const status=hasC?'checking':(hasA&&hasF?'partial':hasA?'available':hasF?'failed':'not_started'); job=updateJob(discordId,jobId,{songNotes:notes,robloxUploads:notes,robloxStatus:status}); for(const n of notes.filter(n=>n.status==='available'&&n.assetId)) savePlayableNote(discordId,job,n,job.robloxDescription); } return job; }
async function uploadJob(discordId,{jobId,accountId,target,assetName,description}){ const job=getJob(discordId,jobId); if(!job) throw new Error('Job not found'); if(job.status!=='done') throw new Error('Conversion is not done'); if(job.filesExpired) throw new Error('Converted files expired'); const accounts=getAccounts(discordId); const account=accounts.find(a=>a.id===accountId); if(!account) throw new Error('Account not found'); updateJob(discordId,jobId,{robloxStatus:'processing',robloxAccountId:account.id,robloxAccountLabel:account.label,robloxDescription:description||account.defaultDescription||DEFAULT_DESCRIPTION,songNotes:[]}); const notes=[]; const outputs=(job.outputs||[]).slice().sort((a,b)=>a.part-b.part); for(const out of outputs){ const file=path.join(OUTPUT_DIR,out.filename); if(!fs.existsSync(file)){ notes.push({part:out.part,name:out.displayName,status:'failed',reason:'Converted file missing or expired'}); continue; } const name=outputs.length>1?`${sanitizeRobloxName(assetName||job.title)} - Part ${out.part}`:sanitizeRobloxName(assetName||job.title); try{ addLog(discordId,jobId,`Uploading Part ${out.part} to Roblox...`); const r=await uploadSingle({account,filePath:file,displayName:name,description:description||account.defaultDescription,target}); notes.push({part:out.part,name,status:'checking',assetId:null,pendingAssetId:r.assetId,operationId:r.operationId,reason:'Waiting for Roblox moderation / availability.',checkAttempts:0,createdAt:new Date().toISOString()}); }catch(e){ notes.push({part:out.part,name,status:'failed',assetId:null,reason:e.message}); } updateJob(discordId,jobId,{songNotes:notes,robloxUploads:notes}); }
 const hasC=notes.some(n=>n.status==='checking'), hasF=notes.some(n=>n.status==='failed'); updateJob(discordId,jobId,{robloxStatus:hasC?'checking':hasF?'failed':'available',songNotes:notes,robloxUploads:notes}); await recheckJob(discordId,jobId,true); return getJob(discordId,jobId); }

cleanupTempDirs();
setInterval(()=>{ cleanupTempDirs(); for(const u of readGlobalUsers()) expireOldFiles(u.id); }, 5*60*1000);
setInterval(()=>{ (async()=>{ for(const u of readGlobalUsers()){ for(const job of getHistory(u.id)){ if((job.songNotes||[]).some(n=>n.status==='checking')) await recheckJob(u.id,job.id,false); } } })().catch(e=>console.error(e)); }, 60*1000);

app.get('/auth/discord', (req,res)=>{ const {clientId}=discordCfg(); if(!clientId) return res.status(500).send('Discord belum dikonfigurasi. Buka halaman setup dulu.'); const state=uuidv4(); const url=new URL('https://discord.com/oauth2/authorize'); url.searchParams.set('client_id',clientId); url.searchParams.set('redirect_uri',DISCORD_CALLBACK_URL); url.searchParams.set('response_type','code'); url.searchParams.set('scope','identify email'); url.searchParams.set('state',state); res.redirect(url.toString()); });
app.get('/auth/discord/callback', async (req,res)=>{ try{ const {clientId,clientSecret}=discordCfg(); const code=String(req.query.code||''); if(!code) return res.status(400).send('Missing code'); const tokenRes=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'authorization_code',code,redirect_uri:DISCORD_CALLBACK_URL})}); const token=await tokenRes.json(); if(!tokenRes.ok) return res.status(400).send(`Discord token error: ${JSON.stringify(token)}`); const meRes=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}}); const me=await meRes.json(); if(!meRes.ok) return res.status(400).send(`Discord user error: ${JSON.stringify(me)}`); const users=readGlobalUsers(); const now=new Date().toISOString(); let user=users.find(u=>u.id===me.id); if(!user){ user={id:me.id,username:me.username,globalName:me.global_name||me.username,avatar:me.avatar,email:me.email||null,firstLoginAt:now,dailyConvertLimit:DEFAULT_DAILY_CONVERT_LIMIT,dailyUploadLimit:DEFAULT_DAILY_UPLOAD_LIMIT,isBlocked:false}; users.unshift(user); ensureUserFiles(me.id); } user.username=me.username; user.globalName=me.global_name||me.username; user.avatar=me.avatar; user.email=me.email||user.email||null; user.lastLoginAt=now; user.lastSeenAt=now; saveGlobalUsers(users); const sessions=readSessions(); const sid=uuidv4(); sessions.push({id:sid,discordId:me.id,createdAt:now,lastSeenAt:now}); saveSessions(sessions); const pid=String(req.query.state||''); if(pid && pendingLogins.has(pid)){ pendingLogins.set(pid,{sid,ts:Date.now()}); return res.send(closeTabHtml()); } setSessionCookie(res,sid); res.redirect('/'); }catch(e){ res.status(500).send(e.message); } });
const pendingLogins = new Map();
function closeTabHtml(){ return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Login berhasil</title><style>*{margin:0;box-sizing:border-box}body{height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(700px 400px at 50% -10%,rgba(34,197,94,.16),transparent 60%),#0a0f0c;color:#eef5f1;font-family:system-ui,'Segoe UI',sans-serif}.c{text-align:center;padding:30px}.ic{width:64px;height:64px;margin:0 auto 16px;border-radius:18px;display:grid;place-items:center;font-size:30px;background:linear-gradient(135deg,#22c55e,#34d399);color:#04130b}.c h1{font-size:21px;margin-bottom:8px}.c p{color:#8b9d94;font-size:14px;line-height:1.6}</style></head><body><div class="c"><div class="ic">✅</div><h1>Login berhasil!</h1><p>Kamu bisa menutup tab/jendela ini.<br>Aplikasi NEV Audio Engine akan otomatis masuk.</p></div></body></html>`; }
function prunePending(){ const now=Date.now(); for(const [k,v] of pendingLogins){ const ts=v&&v.ts?v.ts:0; if(now-ts>10*60*1000 && !(v&&v.sid)) pendingLogins.delete(k); } }
app.get('/api/auth/url', async (req,res)=>{ if(IS_CLIENT){ try{ const r=await centralFetch('/api/auth/url'); return res.status(r.status).json(r.json); }catch(e){ return res.status(502).json({error:'Tidak bisa menghubungi server pusat.'}); } } const {clientId}=discordCfg(); if(!clientId) return res.status(400).json({error:'Discord belum dikonfigurasi.'}); prunePending(); const pid=uuidv4(); pendingLogins.set(pid,{ts:Date.now()}); const url=new URL('https://discord.com/oauth2/authorize'); url.searchParams.set('client_id',clientId); url.searchParams.set('redirect_uri',DISCORD_CALLBACK_URL); url.searchParams.set('response_type','code'); url.searchParams.set('scope','identify email'); url.searchParams.set('state',pid); res.json({ url:url.toString(), pid }); });
app.get('/api/auth/poll', async (req,res)=>{ const pid=String(req.query.pid||''); if(IS_CLIENT){ try{ const r=await centralFetch('/api/auth/poll?pid='+encodeURIComponent(pid)); if(r.json && r.json.ready && r.json.token){ saveAuthToken(r.json.token); clientUserCache={token:null,me:null,ts:0}; return res.json({ready:true}); } return res.json({ready:false}); }catch(e){ return res.json({ready:false}); } } const v=pendingLogins.get(pid); if(v && v.sid){ pendingLogins.delete(pid); setSessionCookie(res,v.sid); return res.json({ready:true, token:`${v.sid}.${sign(v.sid)}`}); } res.json({ready:false}); });
app.get('/api/app-config', async (req,res)=>{ if(IS_CLIENT){ let configured=true; try{ const r=await centralFetch('/api/app-config'); configured=Boolean(r.json && r.json.configured); }catch{} return res.json({ configured, clientId:'', callbackUrl:'', editable:false, desktop:true }); } const {clientId,clientSecret}=discordCfg(); res.json({ configured:Boolean(clientId&&clientSecret), clientId, callbackUrl:DISCORD_CALLBACK_URL, editable:ALLOW_APP_CONFIG, desktop:Boolean(process.env.ELECTRON_RUN_AS_NODE) }); });
app.post('/api/app-config', (req,res)=>{ if(!ALLOW_APP_CONFIG) return res.status(403).json({error:'Config editing is disabled on this deployment.'}); const c=getAppConfig(); if(req.body.discordClientId!==undefined) c.discordClientId=String(req.body.discordClientId||'').trim(); if(req.body.discordClientSecret){ c.discordClientSecretEnc=enc(String(req.body.discordClientSecret).trim()); } saveAppConfig(c); const {clientId,clientSecret}=discordCfg(); res.json({ ok:true, configured:Boolean(clientId&&clientSecret) }); });
app.post('/api/logout', requireAuth, async (req,res)=>{ if(IS_CLIENT){ try{ await centralFetch('/api/logout',{method:'POST',token:req.authToken}); }catch{} clearAuthToken(); clientUserCache={token:null,me:null,ts:0}; return res.json({ok:true}); } const sessions=readSessions().filter(s=>s.id!==req.sessionId); saveSessions(sessions); clearSessionCookie(res); res.json({ok:true}); });
app.get('/api/me', (req,res)=>{ if(IS_CLIENT){ return res.json(req.centralMe || {authenticated:false, user:null}); } res.json({authenticated:Boolean(req.user), user:req.user?{...publicUser(req.user), usageToday: usageSummary(req.user.id, req.user)}:null}); });
app.post('/api/usage/consume', requireAuth, (req,res)=>{ const type=(req.body && req.body.type==='upload')?'upload':'convert'; const err=checkLimit(req,type); if(err) return res.status(429).json({error:err}); bumpUsage(req.user.id,type); res.json({ok:true, usageToday: usageSummary(req.user.id, req.user)}); });

app.get('/api/accounts', requireAuth, (req,res)=> res.json(getAccounts(req.user.id).map(publicAccount)));
app.post('/api/accounts', requireAuth, (req,res)=>{ const accounts=getAccounts(req.user.id); const now=new Date().toISOString(); const incomingKey=String(req.body.apiKey||'').trim(); if(!incomingKey) return res.status(400).json({error:'API key is required'}); const item={id:uuidv4(),label:sanitizeTitle(req.body.label||'Roblox Account'),apiKeyEnc:enc(incomingKey),userId:String(req.body.userId||'').trim(),groupId:String(req.body.groupId||'').trim(),defaultDescription:String(req.body.defaultDescription||DEFAULT_DESCRIPTION),isDefault:accounts.length===0 || Boolean(req.body.isDefault),createdAt:now,updatedAt:now}; if(item.isDefault) accounts.forEach(a=>a.isDefault=false); accounts.push(item); saveAccounts(req.user.id,accounts); res.json(publicAccount(item)); });
app.put('/api/accounts/:id', requireAuth, (req,res)=>{ const accounts=getAccounts(req.user.id); const item=accounts.find(a=>a.id===req.params.id); if(!item) return res.status(404).json({error:'Account not found'}); item.label=sanitizeTitle(req.body.label||item.label); item.userId=String(req.body.userId||'').trim(); item.groupId=String(req.body.groupId||'').trim(); item.defaultDescription=String(req.body.defaultDescription||DEFAULT_DESCRIPTION); const key=String(req.body.apiKey||'').trim(); if(key) item.apiKeyEnc=enc(key); item.updatedAt=new Date().toISOString(); if(req.body.isDefault){ accounts.forEach(a=>a.isDefault=false); item.isDefault=true; } saveAccounts(req.user.id,accounts); res.json(publicAccount(item)); });
app.post('/api/accounts/:id/default', requireAuth, (req,res)=>{ const accounts=getAccounts(req.user.id); accounts.forEach(a=>a.isDefault=a.id===req.params.id); saveAccounts(req.user.id,accounts); res.json(accounts.map(publicAccount)); });
app.delete('/api/accounts/:id', requireAuth, (req,res)=>{ saveAccounts(req.user.id,getAccounts(req.user.id).filter(a=>a.id!==req.params.id)); res.json({ok:true}); });

app.get('/api/history', requireAuth, (req,res)=>{ expireOldFiles(req.user.id); res.json(getHistory(req.user.id)); });
app.get('/api/jobs/available', requireAuth, (req,res)=>{ expireOldFiles(req.user.id); res.json(availableJobs(req.user.id).map(j=>({id:j.id,title:j.title,createdAt:j.createdAt,outputs:j.outputs,filesExpired:j.filesExpired}))); });
app.get('/api/jobs/:id', requireAuth, async (req,res)=>{ expireOldFiles(req.user.id); let job=getJob(req.user.id,req.params.id); if(!job) return res.status(404).json({error:'Job not found'}); if((job.songNotes||[]).some(n=>n.status==='checking')) job=await recheckJob(req.user.id,job.id,false); res.json(job); });
app.delete('/api/history/:id', requireAuth, (req,res)=>{ const h=getHistory(req.user.id); const item=h.find(j=>j.id===req.params.id); if(item&&item.outputs){ for(const o of item.outputs){ const p=path.join(OUTPUT_DIR,o.filename); if(fs.existsSync(p)) try{fs.unlinkSync(p)}catch{} } } saveHistory(req.user.id,h.filter(j=>j.id!==req.params.id)); res.json({ok:true}); });
app.get('/api/notes', requireAuth, (req,res)=> res.json(getNotes(req.user.id)));
app.delete('/api/notes/:id', requireAuth, (req,res)=>{ saveNotes(req.user.id,getNotes(req.user.id).filter(n=>n.id!==req.params.id)); res.json({ok:true}); });
app.post('/api/notes/:jobId/:part/mark-playable', requireAuth, (req,res)=>{ const job=getJob(req.user.id,req.params.jobId); if(!job) return res.status(404).json({error:'Job not found'}); const notes=(job.songNotes||[]).map(n=>{ if(Number(n.part)===Number(req.params.part)){ n.status='available'; n.assetId=n.assetId||n.pendingAssetId||String(req.body.assetId||''); n.availableAt=new Date().toISOString(); n.reason=null; savePlayableNote(req.user.id,job,n,job.robloxDescription); } return n; }); updateJob(req.user.id,job.id,{songNotes:notes,robloxStatus:notes.some(n=>n.status==='checking')?'checking':'available'}); res.json(getJob(req.user.id,job.id)); });
app.post('/api/notes/:jobId/:part/mark-failed', requireAuth, (req,res)=>{ const job=getJob(req.user.id,req.params.jobId); if(!job) return res.status(404).json({error:'Job not found'}); const notes=(job.songNotes||[]).map(n=>{ if(Number(n.part)===Number(req.params.part)){ n.status='failed'; n.reason=String(req.body.reason||'Marked failed manually'); } return n; }); updateJob(req.user.id,job.id,{songNotes:notes}); res.json(getJob(req.user.id,job.id)); });
app.post('/api/jobs/:id/recheck-roblox', requireAuth, async (req,res)=> res.json(await recheckJob(req.user.id,req.params.id,true)));

app.get('/api/youtube-cookies', requireAuth, (req, res) => {
  ensureUserFiles(req.user.id);
  const userCookiesPath = userFile(req.user.id, 'youtube-cookies.txt');
  res.json({
    active: fs.existsSync(userCookiesPath),
    globalActive: fs.existsSync(YT_COOKIES_FILE)
  });
});

app.post('/api/youtube-cookies', requireAuth, (req, res) => {
  ensureUserFiles(req.user.id);
  const content = String(req.body.cookies || '').trim();
  if (!content) return res.status(400).json({ error: 'Cookie content is empty' });
  const userCookiesPath = userFile(req.user.id, 'youtube-cookies.txt');
  fs.writeFileSync(userCookiesPath, content, 'utf8');
  res.json({ ok: true });
});

app.delete('/api/youtube-cookies', requireAuth, (req, res) => {
  ensureUserFiles(req.user.id);
  const userCookiesPath = userFile(req.user.id, 'youtube-cookies.txt');
  if (fs.existsSync(userCookiesPath)) {
    fs.unlinkSync(userCookiesPath);
  }
  res.json({ ok: true });
});

// ===== Asset Monitor (view / delete-archive / grant permission to a universe) =====
function resolveAccount(discordId, accountId){
  const accounts=getAccounts(discordId);
  let acc = accountId ? accounts.find(a=>a.id===accountId) : null;
  if(!acc) acc = accounts.find(a=>a.isDefault) || accounts[0];
  if(!acc) throw new Error('Belum ada akun Roblox dengan API key.');
  const key=dec(acc.apiKeyEnc||acc.apiKey||'');
  if(!key) throw new Error('API key akun ini kosong.');
  return {acc,key};
}
async function rbxJson(url, key, method='GET', body){
  const headers={'x-api-key':key};
  if(body){ headers['Content-Type']='application/json'; }
  const r=await fetch(url,{method,headers,body:body?JSON.stringify(body):undefined});
  const t=await r.text(); let j={}; try{ j=JSON.parse(t); }catch{ j={raw:t}; }
  return {ok:r.ok,status:r.status,json:j,text:t};
}
function rbxErr(r,fallback){ const j=r.json||{}; return (j.error&&(j.error.message||j.error))||j.message||(typeof j.raw==='string'&&j.raw)||`${fallback} (HTTP ${r.status})`; }

// Aggregate published assets the app knows about (from history + saved notes).
app.get('/api/assets', requireAuth, (req,res)=>{
  const seen=new Set(); const out=[];
  for(const job of getHistory(req.user.id)){
    for(const n of (job.songNotes||[])){
      if(!n.assetId) continue; const id=String(n.assetId); if(seen.has(id)) continue; seen.add(id);
      out.push({assetId:id,title:job.title,name:n.name||job.title,part:n.part,jobId:job.id,accountId:job.robloxAccountId||'',accountLabel:job.robloxAccountLabel||'',status:n.status||'available',createdAt:n.availableAt||job.createdAt});
    }
  }
  for(const n of getNotes(req.user.id)){
    if(!n.assetId) continue; const id=String(n.assetId); if(seen.has(id)) continue; seen.add(id);
    out.push({assetId:id,title:n.title,name:n.name||n.title,part:n.part,jobId:n.jobId||'',accountId:n.accountId||'',accountLabel:n.accountName||'',status:'available',createdAt:n.availableAt||n.createdAt});
  }
  out.sort((a,b)=> new Date(b.createdAt||0)-new Date(a.createdAt||0));
  res.json(out);
});

// Live status of one asset (moderation + playable).
app.post('/api/assets/:assetId/refresh', requireAuth, async (req,res)=>{
  try{
    const {acc,key}=resolveAccount(req.user.id,req.body.accountId);
    const info=await rbxJson(`https://apis.roblox.com/assets/v1/assets/${encodeURIComponent(req.params.assetId)}`,key);
    let playable=null; try{ const p=await checkPlayable(acc,req.params.assetId); playable=p.playable; }catch{}
    res.json({assetId:req.params.assetId, ok:info.ok, displayName:info.json?.displayName||null, description:info.json?.description||null, moderationState:info.json?.moderationResult?.moderationState||null, playable, error: info.ok?null:rbxErr(info,'Gagal ambil info asset')});
  }catch(e){ res.status(400).json({error:e.message}); }
});

// Archive (=delete from website/experiences, restorable) and restore.
app.post('/api/assets/:assetId/archive', requireAuth, async (req,res)=>{
  try{
    const {key}=resolveAccount(req.user.id,req.body.accountId);
    const r=await rbxJson(`https://apis.roblox.com/assets/v1/assets/${encodeURIComponent(req.params.assetId)}:archive`,key,'POST');
    if(!r.ok) return res.status(r.status).json({error:rbxErr(r,'Archive gagal')});
    // reflect deletion locally: drop saved playable note for this asset
    saveNotes(req.user.id, getNotes(req.user.id).filter(n=>String(n.assetId)!==String(req.params.assetId)));
    res.json({ok:true,asset:r.json});
  }catch(e){ res.status(400).json({error:e.message}); }
});
app.post('/api/assets/:assetId/restore', requireAuth, async (req,res)=>{
  try{
    const {key}=resolveAccount(req.user.id,req.body.accountId);
    const r=await rbxJson(`https://apis.roblox.com/assets/v1/assets/${encodeURIComponent(req.params.assetId)}:restore`,key,'POST');
    if(!r.ok) return res.status(r.status).json({error:rbxErr(r,'Restore gagal')});
    res.json({ok:true,asset:r.json});
  }catch(e){ res.status(400).json({error:e.message}); }
});

// Grant an experience/universe permission to use this audio asset (collaboration).
app.post('/api/assets/:assetId/grant', requireAuth, async (req,res)=>{
  try{
    const {key}=resolveAccount(req.user.id,req.body.accountId);
    const universeId=String(req.body.universeId||'').trim();
    if(!/^\d+$/.test(universeId)) return res.status(400).json({error:'Universe ID harus angka.'});
    const body={requests:[{assetId:Number(req.params.assetId),universeId:Number(universeId)}]};
    const r=await rbxJson('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions',key,'PATCH',body);
    if(!r.ok) return res.status(r.status).json({error:rbxErr(r,'Grant gagal')+' — pastikan API key punya scope asset-permissions:write.'});
    const errs=(r.json&&r.json.errors)||[];
    if(errs.length) return res.status(400).json({error:'Sebagian gagal: '+JSON.stringify(errs)});
    res.json({ok:true,result:r.json});
  }catch(e){ res.status(400).json({error:e.message}); }
});

app.get('/api/fetch-title', requireAuth, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'URL is required' });
  
  if (IS_CLIENT) {
    try {
      const r = await centralFetch(`/api/fetch-title?url=${encodeURIComponent(url)}`, { token: req.authToken });
      return res.status(r.status).json(r.json);
    } catch (e) {
      return res.status(502).json({ error: 'Server pusat tak terjangkau.' });
    }
  }

  try {
    const normalized = normalizeMediaUrl(url);
    const userCookiesPath = userFile(req.user.id, 'youtube-cookies.txt');
    const hasUserCookies = fs.existsSync(userCookiesPath);
    const hasGlobalCookies = fs.existsSync(YT_COOKIES_FILE);
    const cookiesPath = hasUserCookies ? userCookiesPath : (hasGlobalCookies ? YT_COOKIES_FILE : null);

    const args = [
      '--no-playlist',
      '--force-ipv4',
      '--js-runtimes',
      `deno:${BIN.deno}`,
      '--remote-components',
      'ejs:github',
      '--print',
      'title'
    ];

    if (cookiesPath) {
      args.unshift('--cookies', cookiesPath);
    }
    
    args.push(normalized);

    const resObj = await run(BIN.ytdlp, args);
    const title = resObj.stdout.trim();
    if (!title) {
      throw new Error('Title could not be extracted');
    }
    res.json({ title });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch title' });
  }
});

app.post('/api/jobs/upload', requireAuth, upload.single('audio'), async (req,res)=>{ if(!req.file) return res.status(400).json({error:'Audio file is required'}); const lim=await consumeLimit(req,'convert'); if(lim) return res.status(429).json({error:lim}); const speed=parseFloat(req.body.speed||'2.326'), amplify=parseFloat(req.body.amplify||'-4'); const title=sanitizeTitle(req.body.title||path.parse(req.file.originalname).name); const job=createJob(req.user.id,{title,sourceType:'upload',originalName:req.file.originalname,speed,amplify}); processJob(req.user.id,job.id,req.file.path,title,speed,amplify); res.json({jobId:job.id}); });
app.post('/api/jobs/link', requireAuth, async (req,res)=>{ const url=String(req.body.url||'').trim(); if(!url||!isSupportedLink(url)) return res.status(400).json({error:'Use a YouTube or SoundCloud link'}); const lim=await consumeLimit(req,'convert'); if(lim) return res.status(429).json({error:lim}); const speed=parseFloat(req.body.speed||'2.326'), amplify=parseFloat(req.body.amplify||'-4'); const title=sanitizeTitle(req.body.title||'Downloaded Audio'); const job=createJob(req.user.id,{title,sourceType:'link',sourceUrl:normalizeMediaUrl(url),originalName:'Downloaded Audio',speed,amplify}); processLinkJob(req.user.id,job.id,normalizeMediaUrl(url),title,speed,amplify); res.json({jobId:job.id}); });
app.post('/api/jobs/:id/upload-roblox', requireAuth, async (req,res)=>{ const lim=await consumeLimit(req,'upload'); if(lim) return res.status(429).json({error:lim}); uploadJob(req.user.id,{jobId:req.params.id,accountId:req.body.accountId,target:req.body.target==='group'?'group':'user',assetName:req.body.assetName,description:req.body.description}).catch(e=>{ updateJob(req.user.id,req.params.id,{robloxStatus:'failed'}); addLog(req.user.id,req.params.id,`Roblox upload error: ${e.message}`); }); res.json({ok:true}); });

app.get('/api/admin/users', requireAuth, requireAdmin, async (req,res)=>{ if(IS_CLIENT){ try{ const r=await centralFetch('/api/admin/users',{token:req.authToken}); return res.status(r.status).json(r.json); }catch{ return res.status(502).json({error:'Server pusat tak terjangkau.'}); } } const sessions=readSessions(); const users=readGlobalUsers().map(u=>{ const usage=getUsage(u.id)[todayKey()]||{convert:0,upload:0}; const online=sessions.some(s=>s.discordId===u.id && Date.now()-new Date(s.lastSeenAt||0).getTime()<ONLINE_WINDOW_MS); return {...publicUser(u),usageToday:usage,isOnline:online,accountsCount:getAccounts(u.id).length,historyCount:getHistory(u.id).length,notesCount:getNotes(u.id).length}; }); res.json(users); });
app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req,res)=>{ if(IS_CLIENT){ try{ const r=await centralFetch('/api/admin/users/'+encodeURIComponent(req.params.id),{method:'PUT',token:req.authToken,body:req.body}); return res.status(r.status).json(r.json); }catch{ return res.status(502).json({error:'Server pusat tak terjangkau.'}); } } const users=readGlobalUsers(); const u=users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:'User not found'}); if(req.body.dailyConvertLimit !== undefined) u.dailyConvertLimit=Number(req.body.dailyConvertLimit); if(req.body.dailyUploadLimit !== undefined) u.dailyUploadLimit=Number(req.body.dailyUploadLimit); if(req.body.isBlocked !== undefined) u.isBlocked=Boolean(req.body.isBlocked); saveGlobalUsers(users); res.json(publicUser(u)); });
app.get('/api/admin/users/:id/detail', requireAuth, requireAdmin, (req,res)=>{ const users=readGlobalUsers(); const u=users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:'User not found'}); res.json({user:publicUser(u),usage:getUsage(u.id),accounts:getAccounts(u.id).map(publicAccount),history:getHistory(u.id).slice(0,50),notes:getNotes(u.id).slice(0,50)}); });

app.get('*', (req,res)=> res.sendFile(path.join(PUBLIC_DIR,'index.html')));

function lanAddresses(){
  const out=[];
  const ifaces=os.networkInterfaces();
  for(const name of Object.keys(ifaces)){
    for(const net of ifaces[name]||[]){
      if(net.family==='IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}
function openBrowser(url){
  try{
    const map={win32:['cmd',['/c','start','',url]],darwin:['open',[url]],linux:['xdg-open',[url]]};
    const c=map[process.platform];
    if(!c) return;
    require('child_process').spawn(c[0],c[1],{stdio:'ignore',detached:true}).unref();
  }catch{}
}

app.listen(PORT, ()=>{
  const localUrl=`http://localhost:${PORT}`;
  const lan=lanAddresses().map(ip=>`http://${ip}:${PORT}`);
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║          NEV AUDIO ENGINE — RUNNING          ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
  console.log(`   Local:    ${localUrl}`);
  lan.forEach(u=> console.log(`   Network:  ${u}`));
  console.log('');
  console.log('   Keep this window open while using the app.');
  console.log('   Close this window to stop the server.');
  console.log('');
  // Auto-open the browser when running as the packaged app (disable with OPEN_BROWSER=0)
  if((process.pkg || process.env.OPEN_BROWSER==='1') && process.env.OPEN_BROWSER!=='0'){
    openBrowser(localUrl);
  }
});
