# Frame Player

A personal video player that plays YouTube videos, video links, videos found on webpages, and local files, all with the same controls.

Plain HTML/CSS/JS: no build step and no backend. It runs on GitHub Pages.

## What it plays

| Source | How to open it |
|---|---|
| YouTube (watch, youtu.be, shorts, embed links, `?t=` start times) | Paste the link |
| Direct video links (.mp4, .webm, .mov, .mkv*, .mp3…) | Paste the link |
| HLS streams (.m3u8) | Paste the link (uses hls.js when the browser can't play HLS itself) |
| A webpage with a video on it | Open the page and click the **Send to Frame** bookmarklet |
| Local files | **Open file**, or drag the file onto the window |

\* MKV plays only if the browser supports the codecs inside it.

You can also paste a link anywhere on the page (outside the text box), or open `…/#src=<link>` directly.

## Features

**Basic:** play/pause, ±5 s / ±10 s skip, seek bar with hover time, volume and mute, speed from 0.1× to 4× (YouTube allows 0.25× to 2×), loop, picture-in-picture (not available for YouTube), fullscreen with controls that hide on their own, **zoom** (scroll wheel, pinch, buttons or keys) and **pan** (drag, Shift+arrows).

**Advanced** (turned on and off with the switch in the top bar; the setting is remembered):
- **A-B loop:** set A and B, drag the markers on the seek bar, toggle repeat, clear.
- **Frame by frame:** previous/next frame. The frame rate is detected automatically while the video plays, or you can pick one.
- **Aspect:** Original, Fill (crop), Stretch, 16:9, 4:3, 21:9, 2.35:1, 1:1, 4:5, 9:16, or a custom ratio.

Turning Advanced off also turns off the A-B loop and puts the aspect back to Original. Turning it on again restores them.

Press **?** in the player to see all keyboard shortcuts.

## Limits

- **YouTube** plays through YouTube's official embed. Our controls replace YouTube's, but YouTube's ads and logo still show. Videos whose owner turned off embedding won't play. Frame stepping on YouTube is approximate (it assumes 30 fps). Zooming makes YouTube's picture bigger, not sharper.
- **Webpages:** browsers block one site from reading another site's pages, so pasting a page link only works for the few sites that allow it. The bookmarklet works on most other pages because it runs on the page itself.
- Some sites refuse to let their videos play anywhere else (hotlink protection, links that expire, login-only videos). Paid streaming sites (Netflix, Prime, Hotstar…) are DRM-protected and won't play at all.
- Pages whose player uses `blob:` video sources only work if the bookmarklet can see the underlying `.m3u8`/`.mp4` request.

## Run locally

```bash
python -m http.server 8765
```

Then open http://localhost:8765. YouTube won't play if you open `index.html` as a file; it has to be served from a web address.

## Publish on GitHub Pages

Same setup as `bookmarks-site`: a public repo with Pages serving the `main` branch root.

```bash
git init -b main
git add -A
git commit -m "Frame Player"
gh repo create Amax910/video-player --public --source . --push
gh api -X POST repos/Amax910/video-player/pages -f "source[branch]=main" -f "source[path]=/"
```

The site will then be at https://amax910.github.io/video-player/. After it's published, open the **Bookmarklet** dialog from that address and drag the button to your bookmarks bar again, because the bookmarklet stores the address of the player it was made from.
