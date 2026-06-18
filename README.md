# NEV Audio Engine

Desktop app (Electron) untuk convert audio dan upload ke Roblox sebagai playable asset.
Bisa dijalankan sebagai aplikasi desktop ber-installer, atau sebagai web server.

## Fitur
- Convert audio (upload file atau link YouTube/SoundCloud) ke OGG siap Roblox
- Auto split kalau durasi > 6 menit, fade in/out otomatis
- Upload langsung ke Roblox via Open Cloud API
- Cek status playable / moderation
- Login Discord, history, dan multi-account

## Privasi & Data
Semua data sensitif disimpan **lokal** di komputer user, bukan di server:
- Windows: `%APPDATA%\NEV Audio Engine\data\`
- API key Roblox disimpan **terenkripsi**, kunci enkripsi unik per-install (`secret.json`)
- Cookies, history, akun, sessions — semua lokal

## Download
Installer Windows tersedia di halaman **[Releases](../../releases)**.
Cukup download `NEV Audio Engine Setup x.x.x.exe`, jalankan, lalu install.

## Build sendiri

### Aplikasi desktop (installer Windows)
```bash
npm install
# taruh ffmpeg.exe, ffprobe.exe, yt-dlp.exe, deno.exe di folder bin/
npm run dist:win   # output: dist-app/NEV Audio Engine Setup x.x.x.exe
```
Atau cukup push tag `v*` ke GitHub — workflow CI akan otomatis build installer lengkap
(dengan ffmpeg/yt-dlp/deno) dan publish ke Releases.

### Jalan sebagai web (dev)
```bash
npm install
npm start          # http://localhost:3000
```

### Jalan sebagai desktop (dev)
```bash
npm run app
```

## Konfigurasi Discord (login)
Buat app di https://discord.com/developers/applications, lalu tambahkan redirect:
- Desktop app: `http://localhost:47821/auth/discord/callback`
- Web/dev: `http://localhost:3000/auth/discord/callback`

## Tools eksternal
App memakai `ffmpeg`, `ffprobe`, `yt-dlp`, dan (opsional) `deno`.
Untuk installer, taruh versi `.exe`-nya di `bin/` sebelum build (atau biarkan CI yang download).
