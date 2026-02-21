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

## Persistence Model

The app does **not** persist books automatically.

Use:
- `Options` -> `Import ... PGN` to load repertoire
- `Options` -> `Export ... PGN` to save repertoire

Only imported data in the current session is kept in memory.
