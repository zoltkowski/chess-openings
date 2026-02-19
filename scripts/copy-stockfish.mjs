import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const srcDir = resolve(root, 'node_modules', 'stockfish', 'bin');
const outDir = resolve(root, 'public', 'stockfish');

await mkdir(outDir, { recursive: true });

const files = ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'];
await Promise.all(files.map((file) => copyFile(resolve(srcDir, file), resolve(outDir, file))));
