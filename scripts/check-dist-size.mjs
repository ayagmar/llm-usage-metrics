// Fails when the shipped dist files (the `dist/` entries of package.json `files`) outgrow the
// committed budget. Run after `pnpm run build`. Raise the budget only deliberately: measure the
// new size, set it to that plus 10%, and say why in the commit.
import { readFileSync, statSync } from 'node:fs';

// Measured 2,246,402 bytes after the --top grammar and --by-repo row cap (the budget set at
// 2,037,542 bytes with the bundled context limits had been used up by later features), plus 10%.
const DIST_BUDGET_BYTES = 2_471_000;

const { files } = JSON.parse(readFileSync('package.json', 'utf8'));
const distFiles = files.filter((file) => file.startsWith('dist/'));

if (distFiles.length === 0) {
  throw new Error('package.json `files` lists no dist file; the size check would prove nothing');
}

let totalBytes = 0;

for (const file of distFiles) {
  const { size } = statSync(file);
  console.log(`${file}: ${size.toLocaleString('en-US')} bytes`);
  totalBytes += size;
}

const summary = `dist total: ${totalBytes.toLocaleString('en-US')} of ${DIST_BUDGET_BYTES.toLocaleString('en-US')} bytes`;

if (totalBytes > DIST_BUDGET_BYTES) {
  console.error(
    `${summary}: over budget by ${(totalBytes - DIST_BUDGET_BYTES).toLocaleString('en-US')} bytes`,
  );
  process.exitCode = 1;
} else {
  console.log(summary);
}
