/**
 * Writes the model input hitster.ts builds for one picture as a raw float32
 * file, for comparing with preprocess.py.   npx tsx dump.ts <picture> <out.f32>
 */
import { readFile, writeFile } from 'fs/promises';
import { preprocess } from './hitster';

async function main() {
  const [picture, out] = process.argv.slice(2);
  const letterbox = await preprocess(await readFile(picture));
  await writeFile(out, Buffer.from(letterbox.tensor.buffer));
  console.log(JSON.stringify({ scale: letterbox.scale, offsetX: letterbox.offsetX, offsetY: letterbox.offsetY, width: letterbox.width, height: letterbox.height }));
}

main();
