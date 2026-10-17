import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { createReadDiagnostics, recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
import { normalizeTimestampCandidate, toTokenCount } from '../../src/sources/parsing-utils.js';
import type { SourceAdapter, SourceReadOptions } from '../../src/sources/source-adapter.js';
import { readJsonlFromCursor } from '../../src/stream/cursor.js';
import { asRecord } from '../../src/utils/as-record.js';
import { readClassifiedJsonlObjects } from '../../src/utils/read-jsonl-objects.js';

/**
 * A synthetic incremental adapter whose lines parse on their own. Unlike qwen, it reads
 * through the byte-predicate, classified reader, so a resume test covers both readers.
 */
export class LineLocalAdapter implements SourceAdapter {
  public readonly id = 'line-local';
  public readonly capabilities = { incremental: true };

  public constructor(public readonly parserVersion = 1) {}

  public discoverFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }

  public async *read(
    filePath: string,
    options: SourceReadOptions = {},
  ): AsyncGenerator<UsageEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();
    const lineOptions = {
      shouldParseLineBytes: (lineBytes: Buffer) => lineBytes.includes('"usageMetadata"'),
      isUsageLineBytes: (lineBytes: Buffer) => lineBytes.includes('"type":"assistant"'),
      onMalformedLine: () => {
        recordSkippedRow(diagnostics, 'json_parse_error');
      },
    };
    const lines = options.resume
      ? readJsonlFromCursor(this, filePath, options.resume, (position) =>
          readClassifiedJsonlObjects(filePath, { ...lineOptions, position }),
        )
      : readClassifiedJsonlObjects(filePath, lineOptions);

    for await (const { record, isUsageLine } of lines) {
      if (!isUsageLine) {
        recordSkippedRow(diagnostics, 'not_usage');
        continue;
      }

      const inputTokens = toTokenCount(asRecord(record.usageMetadata)?.promptTokenCount);
      const timestamp = normalizeTimestampCandidate(record.timestamp);

      if (inputTokens === 0 || !timestamp) {
        recordSkippedRow(diagnostics, 'no_token_usage');
        continue;
      }

      yield createUsageEvent({
        source: this.id,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : 'unknown',
        timestamp,
        inputTokens,
        outputTokens: 1,
      });
    }
  }
}
