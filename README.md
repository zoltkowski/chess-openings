# Chess Openings Trainer

React + Vite web app for opening preparation and training.

## https://chess-openings.pages.dev/

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Build

```bash
npm run build
```

Production files are in `dist/`.

## PWA

PWA is enabled with `vite-plugin-pwa`:
- installs as an app (`display: standalone`)
- has offline caching via service worker
- auto-update registration
- blocks common browser refresh shortcuts inside the app (`F5`, `Ctrl/Cmd+R`)
- disables pull-to-refresh style overscroll behavior in app UI

To install:
1. Open the deployed app in Chrome/Edge.
2. Use browser install prompt (`Install app`).

## Cloudflare Pages Deployment

This app is static and ready for Cloudflare Pages.

### Option A: Git integration (recommended)
1. Push repo to GitHub/GitLab.
2. In Cloudflare Dashboard: `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`.
3. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Deploy.

### Option B: CLI deploy
```bash
npm run build
npx wrangler pages deploy dist
```

## Local data and manual backups

The app saves repertoires, settings, and training progress in the browser. Use
**Options → Save backup** to export a JSON copy, then **Options → Restore backup**
to load that copy on another device. Restore replaces the corresponding local
data and reloads the app.

A backup includes both sides' repertoires, enabled and active selections,
annotations, repertoire training statistics, position training for all profiles,
settings, analysis context, and the last saved analysis report. In-progress
exercise sessions and re-downloadable caches are outside the backup. If you
configured a Lichess API token, the JSON contains it. Keep backup files private.

Version 1 backups can still be restored. They leave existing position training
and saved analysis on the receiving device in place. Use the PGN import and
export commands to exchange individual repertoires.
