import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export async function makeThumbnail(srcPath: string, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(srcPath).resize({ width: 320, withoutEnlargement: false }).webp({ quality: 80 }).toFile(outPath);
}
