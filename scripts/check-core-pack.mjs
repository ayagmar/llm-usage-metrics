// Packs @ayagmar/agent-sessions (run `pnpm run core:build` first) and checks the tarball:
// - it ships only dist/**, README.md, LICENSE, package.json and an optional CHANGELOG.md;
// - its manifest has no dependencies of any kind;
// - every exports target is in it;
// - installed offline into a temp project, each subpath loads alone in a fresh Node process;
// - each subpath's built code covers no other source's modules. Like the dist half of
//   packages/core/tests/subpath-isolation.test.ts, this follows each entry's static imports
//   and reads which source files their source maps cover;
// - `./pricing` prices an event from the bundled data files, under Node and, when it is on
//   the PATH, Bun. The files are read at runtime, so only an installed tarball shows they ship
//   where the code looks for them.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const coreRoot = path.join(repoRoot, 'packages', 'core');

const ALLOWED_FILES = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const REQUIRED_FILES = ['package.json', 'README.md', 'LICENSE'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

// The registry builds every adapter. roocode and kilocode are built by the cline family
// adapter, so they may load cline. Every other subpath loads no source module.
const REGISTRY_SUBPATH = './registry';
const SHARED_SOURCE_DIRECTORIES = { roocode: ['cline'], kilocode: ['cline'] };

const STATIC_IMPORT = /^(?:import|export)\s[^;]*?\sfrom\s*"(\.{1,2}\/[^"]+)";?$/gm;
const SIDE_EFFECT_IMPORT = /^import\s*"(\.{1,2}\/[^"]+)";?$/gm;

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function staticImportClosure(entryFile) {
  const seen = new Set();
  const pending = [entryFile];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);

    const code = readFileSync(file, 'utf8');
    for (const match of [...code.matchAll(STATIC_IMPORT), ...code.matchAll(SIDE_EFFECT_IMPORT)]) {
      pending.push(path.resolve(path.dirname(file), match[1]));
    }
  }

  return [...seen];
}

/** The package-relative source files (`src/...`) that `jsFile`'s source map covers. */
function mappedSources(jsFile, packageDir) {
  const map = JSON.parse(readFileSync(`${jsFile}.map`, 'utf8'));
  return map.sources.map((source) =>
    path
      .relative(packageDir, path.resolve(path.dirname(jsFile), source))
      .split(path.sep)
      .join('/'),
  );
}

function sourceIdOf(subpath) {
  return subpath.startsWith('./sources/') ? subpath.slice('./sources/'.length) : undefined;
}

function checkTarballFiles(tarball, failures) {
  const files = run('tar', ['-tzf', tarball])
    .split('\n')
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//, ''));

  const unexpected = files.filter((file) => !file.startsWith('dist/') && !ALLOWED_FILES.has(file));
  if (unexpected.length > 0) {
    failures.push(`unexpected files in the tarball: ${unexpected.join(', ')}`);
  }

  const missing = REQUIRED_FILES.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    failures.push(`missing from the tarball: ${missing.join(', ')}`);
  }

  console.log(
    `tarball: ${files.length} files (${files.filter((f) => f.startsWith('dist/')).length} under dist/)`,
  );
  return new Set(files);
}

function checkManifest(manifest, files, failures) {
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] !== undefined && Object.keys(manifest[field]).length > 0) {
      failures.push(`package.json declares ${field}`);
    }
  }

  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    for (const target of Object.values(conditions)) {
      if (!files.has(path.posix.normalize(target))) {
        failures.push(`exports["${subpath}"] target ${target} is not in the tarball`);
      }
    }
  }
}

function installTarball(tarball, scratch) {
  const projectDir = path.join(scratch, 'project');
  mkdirSync(projectDir);
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'core-pack-check', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--cache',
      path.join(scratch, 'npm-cache'),
      tarball,
    ],
    projectDir,
  );
  return projectDir;
}

function checkSubpath(manifest, subpath, projectDir, sourceIds, failures) {
  const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;

  try {
    run(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)});`],
      projectDir,
    );
  } catch (error) {
    failures.push(`${specifier} does not load alone: ${String(error.stderr ?? error).trim()}`);
    return;
  }

  const packageDir = path.join(projectDir, 'node_modules', ...manifest.name.split('/'));
  const entryFile = path.join(packageDir, manifest.exports[subpath].import);
  const sources = new Set(
    staticImportClosure(entryFile).flatMap((file) => mappedSources(file, packageDir)),
  );

  const ownId = sourceIdOf(subpath);
  const sourceFamily = (id) => [id, ...(SHARED_SOURCE_DIRECTORIES[id] ?? [])];
  const covers = (id) => [...sources].some((source) => source.startsWith(`src/sources/${id}/`));

  // Positive controls: the source maps resolve into src/, the registry is seen loading every
  // source and a source entry its own modules, so an empty leak list means something.
  if (sources.size === 0 || [...sources].some((source) => !source.startsWith('src/'))) {
    failures.push(`${specifier}: its source maps do not resolve into src/`);
    return;
  }
  const expected = subpath === REGISTRY_SUBPATH ? sourceIds : ownId === undefined ? [] : [ownId];
  const unseen = expected.filter((id) => !sourceFamily(id).some(covers));
  if (unseen.length > 0) {
    failures.push(`${specifier}: its source maps cover no module of ${unseen.join(', ')}`);
    return;
  }

  if (subpath === REGISTRY_SUBPATH) {
    console.log(`ok ${specifier} (loads every source)`);
    return;
  }

  const allowed = new Set(ownId === undefined ? [] : sourceFamily(ownId));
  const leaked = [...sources].filter((source) =>
    sourceIds.some((id) => !allowed.has(id) && source.startsWith(`src/sources/${id}/`)),
  );

  if (leaked.length > 0) {
    failures.push(`${specifier} bundles other source modules: ${leaked.sort().join(', ')}`);
    return;
  }

  console.log(`ok ${specifier}`);
}

// Prices one Claude event (1M input and 1M output tokens) from the bundled data with the
// network stubbed out, and prints the cost.
const PRICE_FIXTURE_EVENT = `
globalThis.fetch = () => { throw new Error('the bundled prices must not fetch'); };
const { createUsageEvent } = await import('@ayagmar/agent-sessions');
const { loadBundledPricing, priceEvents } = await import('@ayagmar/agent-sessions/pricing');
const event = createUsageEvent({
  source: 'claude',
  sessionId: 'pack-check',
  timestamp: '2026-01-01T00:00:00Z',
  model: 'claude-sonnet-4-5-20250929',
  inputTokens: 1000000,
  outputTokens: 1000000,
});
const [priced] = priceEvents([event], await loadBundledPricing());
console.log(JSON.stringify({ costUsd: priced.costUsd, costMode: priced.costMode }));
`;
const EXPECTED_FIXTURE_PRICE = JSON.stringify({ costUsd: 18, costMode: 'estimated' });

function hasBun() {
  try {
    run('bun', ['--version'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function checkPricing(projectDir, failures) {
  const runtimes = [['node', process.execPath, ['--input-type=module', '-e']]];
  if (hasBun()) {
    runtimes.push(['bun', 'bun', ['-e']]);
  } else {
    console.log('bun is not on the PATH: ./pricing checked under Node only');
  }

  for (const [name, command, args] of runtimes) {
    try {
      const output = run(command, [...args, PRICE_FIXTURE_EVENT], projectDir).trim();
      if (output !== EXPECTED_FIXTURE_PRICE) {
        failures.push(`./pricing under ${name} priced the fixture event as ${output}`);
        continue;
      }
      console.log(`ok ./pricing prices an event under ${name}`);
    } catch (error) {
      failures.push(`./pricing under ${name}: ${String(error.stderr ?? error).trim()}`);
    }
  }
}

function main() {
  if (!existsSync(path.join(coreRoot, 'dist'))) {
    console.error('packages/core/dist is missing: run `pnpm run core:build` first.');
    process.exit(1);
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'core-pack-check-'));
  const failures = [];

  try {
    run('pnpm', ['pack', '--pack-destination', scratch], coreRoot);
    const tarballName = readdirSync(scratch).find((entry) => entry.endsWith('.tgz'));
    if (tarballName === undefined) {
      throw new Error(`pnpm pack wrote no tarball to ${scratch}`);
    }
    const tarball = path.join(scratch, tarballName);

    const files = checkTarballFiles(tarball, failures);
    const manifest = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
    checkManifest(manifest, files, failures);

    const projectDir = installTarball(tarball, scratch);
    const subpaths = Object.keys(manifest.exports);
    const sourceIds = subpaths.map(sourceIdOf).filter((id) => id !== undefined);
    for (const subpath of subpaths) {
      checkSubpath(manifest, subpath, projectDir, sourceIds, failures);
    }
    checkPricing(projectDir, failures);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`core pack check failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }

  console.log('core pack check passed');
}

main();
