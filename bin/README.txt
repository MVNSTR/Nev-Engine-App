Place the Windows tool executables here BEFORE building the installer:

  ffmpeg.exe
  ffprobe.exe
  yt-dlp.exe
  deno.exe     (optional, for some YouTube links)

These get bundled into the installer (extraResources -> app/bin) so users
don't need to install anything separately.

Downloads:
  ffmpeg/ffprobe : https://www.gyan.dev/ffmpeg/builds/
  yt-dlp         : https://github.com/yt-dlp/yt-dlp/releases/latest
  deno           : https://github.com/denoland/deno/releases/latest
