import path from 'node:path';

import type { SourceAdapter, SourceParseFileDiagnostics } from './source-adapter.js';

/**
 * Reports several directories of a single-directory source as one source: one adapter per
 * directory, with each file parsed by the adapter that discovered it. Parsing a file
 * never depends on which other directories were configured, so the parse cache stays valid.
 */
export class MultiDirectorySourceAdapter implements SourceAdapter {
  public readonly id: SourceAdapter['id'];
  public readonly parserVersion: SourceAdapter['parserVersion'];
  public readonly capabilities: SourceAdapter['capabilities'];

  private readonly adapters: readonly SourceAdapter[];
  private adapterByFile = new Map<string, SourceAdapter>();

  public constructor(adapters: readonly SourceAdapter[]) {
    if (adapters.length === 0) {
      throw new Error('MultiDirectorySourceAdapter needs at least one adapter');
    }

    const firstAdapter = adapters[0];
    this.adapters = adapters;
    this.id = firstAdapter.id;
    this.parserVersion = firstAdapter.parserVersion;
    this.capabilities = firstAdapter.capabilities;
  }

  public getSearchPaths(): string[] {
    return this.adapters.flatMap((adapter) => adapter.getSearchPaths?.() ?? []);
  }

  /** Each call reflects the directories as they are now, like any other adapter. */
  public async discoverFiles(): Promise<string[]> {
    const files: string[] = [];
    const discoveredPaths = new Set<string>();
    const adapterByFile = new Map<string, SourceAdapter>();

    for (const adapter of this.adapters) {
      for (const filePath of await adapter.discoverFiles()) {
        // Overlapping or equivalent directories must not count a file twice.
        const resolvedPath = path.resolve(filePath);

        if (!discoveredPaths.has(resolvedPath)) {
          discoveredPaths.add(resolvedPath);
          adapterByFile.set(filePath, adapter);
          files.push(filePath);
        }
      }
    }

    this.adapterByFile = adapterByFile;
    return files;
  }

  private getAdapterForFile(filePath: string): SourceAdapter {
    return this.adapterByFile.get(filePath) ?? this.adapters[0];
  }

  public async parseFile(filePath: string) {
    return this.getAdapterForFile(filePath).parseFile(filePath);
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const adapter = this.getAdapterForFile(filePath);

    if (adapter.parseFileWithDiagnostics) {
      return adapter.parseFileWithDiagnostics(filePath);
    }

    return { events: await adapter.parseFile(filePath), skippedRows: 0, skippedRowReasons: [] };
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return (await this.getAdapterForFile(filePath).getParseDependencies?.(filePath)) ?? [];
  }
}
