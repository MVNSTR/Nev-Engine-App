# NEV Audio Engine

Aplikasi desktop (Electron) untuk convert audio dan upload ke Roblox sebagai
playable asset. Tersedia sebagai installer Windows dengan auto-update, dan juga
bisa dijalankan sebagai web server.

## Fitur
- Convert audio (upload file atau link YouTube/SoundCloud) ke OGG siap Roblox
- Auto split kalau durasi > 6 menit, fade in/out otomatis
- Upload langsung ke Roblox via Open Cloud API + cek status playable
- Login Discord lewat browser default (loopback, "tutup tab → app auto-login")
- Tab Admin (khusus Discord ID admin) untuk mengatur limit user
- Limit harian: user biasa 10 convert / 10 upload, admin unlimited
- Auto-update wajib saat ada versi baru (tanpa uninstall/reinstall)

## Privasi & Data (lokal)
Semua data konten disimpan lokal di mesin user (tidak di server):
- Windows: `%APPDATA%\NEV Audio Engine\data\`
- `accounts.json` (API key Roblox **terenkripsi** AES-256-GCM), `youtube-cookies.txt`,
  `history.json`, `notes.json`, `usage.json`
- Kunci enkripsi unik per-install (`secret.json`, dibuat acak saat pertama jalan)
- Token login disimpan lokal (`auth.json`)

## Alur Login (Discord via browser)
1. Klik "Login dengan Discord" → app membuka browser default.
2. Selesai authorize → halaman menampilkan "Login berhasil! Kamu bisa menutup tab ini."
3. App mendeteksi login selesai (polling) lalu otomatis masuk.

## Arsitektur auth: lokal vs terpusat
Secara default, identitas Discord + limit + sesi disimpan **lokal** per-install.
Untuk model **terpusat** (admin mengontrol semua user dari satu tempat), set
`CENTRAL_AUTH_URL` di aplikasi desktop ke URL server pusat (lihat `spesifikasi.txt`).
Server pusat memegang Discord Client ID/Secret, daftar user, limit, dan admin.
Status implementasi terpusat: lihat catatan di `spesifikasi.txt`.

## Download
Installer Windows ada di halaman **[Releases](../../releases)**.
Download `NEV Audio Engine Setup x.x.x.exe`, jalankan, install.

## Build sendiri
```bash
npm install
# taruh ffmpeg.exe, ffprobe.exe, yt-dlp.exe, deno.exe di folder bin/
npm run dist:win   # output: dist-app/NEV Audio Engine Setup x.x.x.exe
```
Atau push tag `v*` ke GitHub — CI otomatis build installer lengkap (dengan
ffmpeg/yt-dlp/deno) lalu publish + `latest.yml` ke Releases untuk auto-update.

### Jalan sebagai web (dev) / desktop (dev)
```bash
npm start    # web di http://localhost:3000
npm run app  # desktop (Electron)
```

## Konfigurasi Discord
Buat app di https://discord.com/developers/applications, tambahkan redirect:
- Desktop app: `http://localhost:47821/auth/discord/callback`
- Web/dev: `http://localhost:3000/auth/discord/callback`

## Rilis update
1. Naikkan `version` di `package.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. CI build + publish ke Releases. Semua user dapat himbauan update otomatis.

## Tools eksternal
`ffmpeg`, `ffprobe`, `yt-dlp`, dan (opsional) `deno`. Untuk installer, taruh
versi `.exe`-nya di `bin/` sebelum build (atau biarkan CI yang download).
