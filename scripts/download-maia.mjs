import { mkdir, rename, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = [
  ['maia3-79m.fp16.onnx', 'https://huggingface.co/bqrio/maia3-onnx/resolve/main/maia3-79m.fp16.onnx?download=true'],
  ['all_moves.json', 'https://unpkg.com/maia3-js@0.2.0/data/moves.json'],
];
const outDir = resolve(process.cwd(), 'public', 'maia', 'maia3');
await mkdir(outDir, { recursive: true });
const modelFile = assets[0][0];
const cacheDir = resolve(process.cwd(), 'node_modules', '.cache', 'maia3');
await mkdir(cacheDir, { recursive: true });
// Keep the full model outside public: Pages limits each deployed file to 25 MiB.
const assetPath = (file) => resolve(file.endsWith('.onnx') ? cacheDir : outDir, file);
try {
  await rename(resolve(outDir, modelFile), assetPath(modelFile));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function isReady(file) {
  const target = assetPath(file);
  try {
    if (file.endsWith('.json')) return Object.keys(JSON.parse(await readFile(target, 'utf8'))).length === 4352;
    return (await stat(target)).size > 100_000_000;
  } catch {
    return false;
  }
}

for (const [file, url] of assets) {
  const target = assetPath(file);
  if (await isReady(file)) {
    console.log(`Already prepared ${file}`);
    continue;
  }
  const temporary = `${target}.download`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download Maia asset ${file}: ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (file.endsWith('.json')) {
      const moveList = JSON.parse(content.toString('utf8'));
      if (!Array.isArray(moveList) || moveList.length !== 4352) throw new Error('Downloaded Maia-3 move list must contain 4,352 entries');
      const moveMap = Object.fromEntries(moveList.map((uci, index) => [uci, index]));
      await writeFile(temporary, JSON.stringify(moveMap));
    } else if (content.length < 100_000_000) {
      throw new Error('Downloaded Maia-3 ONNX model is unexpectedly small');
    } else {
      await writeFile(temporary, content);
    }
    await rename(temporary, target);
    console.log(`Downloaded ${file}`);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const model = await readFile(assetPath(modelFile));
const chunkSize = 20 * 1024 * 1024;
const parts = [];
for (let offset = 0; offset < model.length; offset += chunkSize) {
  const file = `${modelFile}.part-${parts.length}`;
  const chunk = model.subarray(offset, offset + chunkSize);
  await writeFile(resolve(outDir, file), chunk);
  parts.push({ file, size: chunk.length });
}
await writeFile(resolve(outDir, `${modelFile}.json`), JSON.stringify({ size: model.length, parts }));
console.log(`Prepared Maia model as ${parts.length} parts (at most 20 MiB each)`);
