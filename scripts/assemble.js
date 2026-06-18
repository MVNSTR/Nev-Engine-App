// Assembles the distributable folder after pkg builds the executable.
// Copies the public/ web UI next to the exe and prepares a bin/ folder
// where ffmpeg / ffprobe / yt-dlp / deno must be placed.
const fs = require('fs');
const path = require('path');

const platform = process.argv[2] || 'win';
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function copyDir(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.endsWith('.bak')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.mkdirSync(dist, { recursive: true });

// 1) Web UI
copyDir(path.join(root, 'public'), path.join(dist, 'public'));

// 2) bin/ folder for external tools
const binDir = path.join(dist, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const ext = platform === 'win' ? '.exe' : '';
fs.writeFileSync(
  path.join(binDir, 'README.txt'),
  [
    'Put these executables in THIS folder:',
    '',
    `  ffmpeg${ext}`,
    `  ffprobe${ext}`,
    `  yt-dlp${ext}`,
    `  deno${ext}    (only needed for some YouTube links)`,
    '',
    'Download links:',
    '  ffmpeg/ffprobe : https://www.gyan.dev/ffmpeg/builds/  (Windows) or https://ffmpeg.org/download.html',
    '  yt-dlp         : https://github.com/yt-dlp/yt-dlp/releases/latest',
    '  deno           : https://github.com/denoland/deno/releases/latest',
    '',
    'If a tool is missing here, the app will fall back to the system PATH.'
  ].join('\n')
);

// 3) Sample config (edit and rename to start.bat env, or set as environment variables)
fs.writeFileSync(
  path.join(dist, 'config.example.env'),
  [
    'PORT=3000',
    'BASE_URL=http://localhost:3000',
    '# Discord login (create an app at https://discord.com/developers/applications)',
    '# Add this redirect URL in the Discord portal: http://localhost:3000/auth/discord/callback',
    'DISCORD_CLIENT_ID=',
    'DISCORD_CLIENT_SECRET=',
    'DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback',
    'SESSION_SECRET=change-me-to-a-long-random-string',
    'APP_SECRET=change-me-to-a-long-random-string',
    'ADMIN_DISCORD_IDS=',
    'DEFAULT_DAILY_CONVERT_LIMIT=10',
    'DEFAULT_DAILY_UPLOAD_LIMIT=10'
  ].join('\n')
);

// 4) Windows launcher that loads config.env then starts the exe
if (platform === 'win') {
  fs.writeFileSync(
    path.join(dist, 'Start NEV Audio Engine.bat'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      'if exist config.env (',
      '  for /f "usebackq tokens=1,* delims==" %%a in ("config.env") do (',
      '    echo %%a| findstr /b "#" >nul || set "%%a=%%b"',
      '  )',
      ')',
      'start "" "NEV-Audio-Engine.exe"',
      ''
    ].join('\r\n')
  );
}

console.log('[assemble] dist/ ready:', dist);
console.log('[assemble] Remember to drop the binaries into dist/bin/');
