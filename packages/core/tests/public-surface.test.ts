import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every name each subpath exports, values and types alike. A name missing here fails the
// test, so a new export is a deliberate choice. Each task appends its names in its own
// commented block; blocks are merged and sorted before comparing, so their order does not
// matter. `@internal`-tagged names are listed too.
const EXPECTED_SURFACE: Record<string, readonly string[]> = {
  '.': [
    // T0
    'CORE_EVENT_VERSION',
    'CostMode',
    'EVENT_KINDS',
    'EventKind',
    'IDLE_GAP_CAP_MS',
    'MessageEvent',
    'MessageEventInput',
    'NumberLike',
    'ReadEventsOptions',
    'SessionEvent',
    'SessionMetaEvent',
    'SessionMetaEventInput',
    'SessionMetaFields',
    'SourceAdapter',
    'SourceAdapterPathOptions',
    'SourceCapabilities',
    'SourceContext',
    'SourceDiagnostic',
    'SourceId',
    'SourceParseFileDiagnostics',
    'SourceReadDiagnostics',
    'SourceReadOptions',
    'SourceSkippedRowReasonStat',
    'Stage',
    'ToolCallEvent',
    'ToolCallEventInput',
    'ToolCallStatus',
    'USAGE_EVENT_NORMALIZATION_VERSION',
    'UsageEvent',
    'UsageEventInput',
    'UsageRecord',
    'UsageRecordInput',
    'collect',
    'collectFile',
    'computeActiveMs',
    'computeEventContentHash',
    'copiedSessions',
    'createMessageEvent',
    'createReadDiagnostics',
    'createSessionMetaEvent',
    'createSourceContext',
    'createToolCallEvent',
    'createUsageEvent',
    'createUsageRecord',
    'dedupeCopiedSessions',
    'dedupeRepeatedAcrossFiles',
    'getEventSessionKey',
    'getParserVersion',
    'isUsageRecord',
    'kinds',
    'normalizeSourceId',
    'normalizeTimestamp',
    'pipe',
    'readEnvPath',
    'readEvents',
    'repeatedAcrossFiles',
    'toParseDiagnostics',
  ],
  './internal': [
    // T0
    'BillableTokenUsage',
    'BoundedJsonReadResult',
    'ClassifiedJsonlObject',
    'DiscoverFilesOptions',
    'FileDependencyFingerprint',
    'FileFingerprint',
    'MAX_JSON_TRANSCRIPT_BYTES',
    'MultiDirectorySourceAdapter',
    'MultiRootDiscoveryOptions',
    'ReadClassifiedJsonlObjectsOptions',
    'ReadJsonlObjectsOptions',
    'SleepFn',
    'SplitPromptTokens',
    'SqliteModule',
    'UsageTotalTokenBuckets',
    'addHashCount',
    'asRecord',
    'asTrimmedText',
    'collectCanonicalProviderRoots',
    'compareByCodePoint',
    'discoverFiles',
    'discoverFilesAcrossRoots',
    'discoverJsonlFiles',
    'formatSqliteError',
    'getFileByteSize',
    'getFileFingerprint',
    'getNewestFingerprintMtimeMs',
    'getPrimaryFingerprintByteSize',
    'getRepeatingSourceIds',
    'getSessionCopyingSourceIds',
    'hasBillableTokenBuckets',
    'hasControlCharacters',
    'hasErrorCode',
    'hasPositiveUsageOrCostSignal',
    'incrementSkippedReason',
    'inferCanonicalProviderRootFromModel',
    'inferCanonicalProviderRootsFromModels',
    'intersectCanonicalProviderRoots',
    'isBlankText',
    'isBusyOrLockedSqliteError',
    'isPathWithinRoots',
    'isPriceableEvent',
    'loadNodeSqliteModule',
    'loadNodeSqliteModuleFromRequire',
    'matchesCanonicalProviderFilter',
    'normalizeNonNegativeInteger',
    'normalizeOptionalModel',
    'normalizeProviderToBillingEntity',
    'normalizeTimestampCandidate',
    'normalizeUsdCost',
    'pathExists',
    'pathIsDirectory',
    'pathIsFile',
    'pathReadable',
    'pathStat',
    'readBoundedJsonFile',
    'readClassifiedJsonlObjects',
    'readFirstLine',
    'readJsonTranscriptFile',
    'readJsonlObjects',
    'recordSkippedRow',
    'resolveExplicitProviderRoots',
    'resolveRootDirs',
    'resolveTotalTokens',
    'resolveUsageTotalTokens',
    'runWithBusyRetries',
    'splitPromptIncludingCachedTokens',
    'stripControlCharacters',
    'takeUncountedEvents',
    'toFiniteNumber',
    'toNumberLike',
    'toOpenCodeDbReadError',
    'toTerminalLine',
    'toTokenCount',
  ],
  './registry': [
    // T0
    'SourceSelection',
    'SourceStorageFormat',
    'canParseSourceOnWorker',
    'createDefaultAdapters',
    'createWorkerParseAdapter',
    'getDefaultSourceIds',
    'getSourceStorageFormat',
    'sourceSupportsDirectories',
  ],
  './sources/amp': [
    // T0
    'AmpSourceAdapter',
    'AmpSourceAdapterOptions',
  ],
  './sources/antigravity': [
    // T0
    'AntigravitySourceAdapter',
    'AntigravitySourceAdapterOptions',
  ],
  './sources/claude': [
    // T0
    'ClaudeSourceAdapter',
    'ClaudeSourceAdapterOptions',
  ],
  './sources/cline': [
    // T0
    'CLINE_EXTENSION_IDS',
    'ClineFamilyAdapter',
    'ClineFamilyAdapterOptions',
    'createClineFamilyAdapter',
  ],
  './sources/codex': [
    // T0
    'CodexSourceAdapter',
    'CodexSourceAdapterOptions',
    'LEGACY_CODEX_MODEL_FALLBACK',
    'resolveDefaultCodexSessionsDir',
  ],
  './sources/copilot': [
    // T0
    'CopilotSourceAdapter',
    'CopilotSourceAdapterOptions',
  ],
  './sources/droid': [
    // T0
    'DroidSourceAdapter',
    'DroidSourceAdapterOptions',
  ],
  './sources/dsh': [
    // T0
    'DshSourceAdapter',
    'DshSourceAdapterOptions',
    'getDefaultDshSessionsDir',
  ],
  './sources/gemini': [
    // T0
    'GeminiSourceAdapter',
    'GeminiSourceAdapterOptions',
  ],
  './sources/goose': [
    // T0
    'GooseSourceAdapter',
    'GooseSourceAdapterOptions',
  ],
  './sources/kilocode': [
    // T0
    'CLINE_EXTENSION_IDS',
    'ClineFamilyAdapterOptions',
    'createClineFamilyAdapter',
  ],
  './sources/kimi': [
    // T0
    'KimiSourceAdapter',
    'KimiSourceAdapterOptions',
  ],
  './sources/openclaw': [
    // T0
    'OpenClawSourceAdapter',
    'OpenClawSourceAdapterOptions',
  ],
  './sources/opencode': [
    // T0
    'OpenCodeSourceAdapter',
    'OpenCodeSourceAdapterOptions',
  ],
  './sources/pi': [
    // T0
    'PiSourceAdapter',
    'PiSourceAdapterOptions',
  ],
  './sources/qwen': [
    // T0
    'QwenSourceAdapter',
    'QwenSourceAdapterOptions',
  ],
  './sources/roocode': [
    // T0
    'CLINE_EXTENSION_IDS',
    'ClineFamilyAdapterOptions',
    'createClineFamilyAdapter',
  ],
};

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

type PackageExports = Record<string, { import: string }>;

const packageExports = (
  JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    exports: PackageExports;
  }
).exports;

/** The source entry of a `dist` export target: `./dist/x/index.js` -> `src/x/index.ts`. */
function sourceEntry(target: string): string {
  return path.join(packageRoot, target.replace(/^\.\/dist\//u, 'src/').replace(/\.js$/u, '.ts'));
}

function readSurface(): { names: Record<string, string[]>; diagnostics: string[] } {
  const entries = Object.entries(packageExports).map(
    ([subpath, target]) => [subpath, sourceEntry(target.import)] as const,
  );
  const program = ts.createProgram(
    entries.map(([, file]) => file),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    },
  );
  const checker = program.getTypeChecker();
  const names: Record<string, string[]> = {};
  const diagnostics: string[] = [];

  for (const [subpath, file] of entries) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);

    if (!sourceFile || !moduleSymbol) {
      throw new Error(`No module for ${subpath} at ${file}`);
    }

    names[subpath] = checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => symbol.name)
      .sort();
    // An export star that two modules both satisfy drops the name silently (TS2308).
    diagnostics.push(
      ...program
        .getSemanticDiagnostics(sourceFile)
        .map((diagnostic) => `${subpath}: TS${String(diagnostic.code)}`),
    );
  }

  return { names, diagnostics };
}

describe('public surface', () => {
  it('exports exactly the listed names from each subpath', () => {
    const { names, diagnostics } = readSurface();
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_SURFACE).map(([subpath, list]) => [subpath, [...list].sort()]),
    );

    expect(diagnostics).toEqual([]);
    expect(names).toEqual(expected);
  }, 60_000);
});
