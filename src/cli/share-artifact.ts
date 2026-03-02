import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeShareSvgFile(fileName: string, svgContent: string): Promise<string> {
  const outputPath = path.resolve(process.cwd(), fileName);
  await writeFile(outputPath, svgContent, 'utf8');
  return outputPath;
}
