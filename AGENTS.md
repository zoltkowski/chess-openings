# Repository Instructions

## Project

- This is a React, TypeScript, and Vite chess openings trainer.
- Use the existing npm scripts for development and builds.
- Keep generated output in `dist/` and do not commit `node_modules/`.

## Chess Engines

- When implementing full-game review, follow `docs/game-analysis-spec.md`.
  It defines classification, Maia difficulty, safeguards against praising
  obvious moves, safe simplification, exercises, and acceptance criteria.

- Stockfish runs in a browser worker from `public/stockfish/`.
- `scripts/copy-stockfish.mjs` copies the selected lite, single-threaded
  Stockfish.js WebAssembly files from the installed `stockfish` npm package.
- Maia inference lives in `src/maiaEngine.ts`; its model and matching move
  vocabulary are served from `public/maia/maia3/`.
- Run `npm run prepare:maia` to fetch Maia-3 model assets. Keep the model,
  tokenizer or move vocabulary, and inference input/output contract aligned.

## Python Tooling

- For Python projects and scripts, always use `uv` (`uv run`, `uv sync`, or
  `uv add`) rather than invoking `python` or `pip` directly.
