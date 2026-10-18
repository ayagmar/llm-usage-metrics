import { StringDecoder } from 'node:string_decoder';

import { readFileChunks } from '../../utils/read-file-chunks.js';
import { asTrimmedText } from '../parsing-utils.js';

const ENVIRONMENT_DETAILS_OPEN_TAG = '<environment_details>';
const ENVIRONMENT_DETAILS_CLOSE_TAG = '</environment_details>';
const MODEL_OPEN_TAG = '<model>';
const MODEL_CLOSE_TAG = '</model>';

// A tag cut by a chunk boundary is found once the next chunk arrives, so each scan keeps
// the last (longest tag length - 1) characters it could not rule out.
const TAG_OVERLAP_LENGTH =
  Math.max(
    ENVIRONMENT_DETAILS_OPEN_TAG.length,
    ENVIRONMENT_DETAILS_CLOSE_TAG.length,
    MODEL_OPEN_TAG.length,
    MODEL_CLOSE_TAG.length,
  ) - 1;

/**
 * Finds the first `<model>` text inside the last complete `<environment_details>` block,
 * keeping only that block's model text and the open block's candidate. A block runs from
 * an open tag to the next close tag (an open tag inside it is plain text), and an open
 * tag that never closes ends the search. Conversation history is untrusted,
 * multi-megabyte text, so tags are found with `indexOf`, never regexes.
 */
class HistoryModelScanner {
  private carried = '';
  private inBlock = false;
  private modelPhase: 'seek' | 'text' | 'done' = 'seek';
  private modelTextStart = 0;
  private modelTextParts: string[] = [];
  private blockModelText: string | undefined;
  private lastCompleteModelText: string | undefined;

  public feed(text: string): void {
    const content = this.carried + text;
    let position = 0;

    for (;;) {
      if (!this.inBlock) {
        const openStart = content.indexOf(ENVIRONMENT_DETAILS_OPEN_TAG, position);

        if (openStart === -1) {
          this.carry(content, position);
          return;
        }

        position = openStart + ENVIRONMENT_DETAILS_OPEN_TAG.length;
        this.inBlock = true;
        this.modelPhase = 'seek';
        this.modelTextParts = [];
        this.blockModelText = undefined;
        continue;
      }

      const closeStart = content.indexOf(ENVIRONMENT_DETAILS_CLOSE_TAG, position);
      const blockEnd = closeStart === -1 ? content.length : closeStart;

      if (this.modelPhase === 'seek') {
        const modelStart = content.indexOf(MODEL_OPEN_TAG, position);

        if (modelStart !== -1 && modelStart < blockEnd) {
          position = modelStart + MODEL_OPEN_TAG.length;
          this.modelPhase = 'text';
          this.modelTextStart = position;
          continue;
        }
      } else if (this.modelPhase === 'text') {
        const modelEnd = content.indexOf(MODEL_CLOSE_TAG, position);

        if (modelEnd !== -1 && modelEnd < blockEnd) {
          this.modelTextParts.push(content.slice(this.modelTextStart, modelEnd));
          this.blockModelText = this.modelTextParts.join('');
          this.modelTextParts = [];
          position = modelEnd + MODEL_CLOSE_TAG.length;
          this.modelPhase = 'done';
          continue;
        }
      }

      if (closeStart !== -1) {
        this.lastCompleteModelText = this.blockModelText;
        this.modelTextParts = [];
        position = closeStart + ENVIRONMENT_DETAILS_CLOSE_TAG.length;
        this.inBlock = false;
        continue;
      }

      this.carry(content, position);
      return;
    }
  }

  /** The model text, trimmed, of the last block that closed. */
  public result(): string | undefined {
    return asTrimmedText(this.lastCompleteModelText);
  }

  private carry(content: string, position: number): void {
    const keepFrom = Math.max(position, content.length - TAG_OVERLAP_LENGTH);

    if (this.inBlock && this.modelPhase === 'text') {
      this.modelTextParts.push(content.slice(this.modelTextStart, keepFrom));
      this.modelTextStart = 0;
    }

    this.carried = content.slice(keepFrom);
  }
}

/** Any read error, even after part of the file was scanned, means no model. */
export async function loadHistoryModel(
  historyPath: string,
  chunkSize?: number,
): Promise<string | undefined> {
  const decoder = new StringDecoder('utf8');
  const scanner = new HistoryModelScanner();

  try {
    for await (const chunk of readFileChunks(historyPath, chunkSize)) {
      scanner.feed(decoder.write(chunk));
    }

    scanner.feed(decoder.end());
  } catch {
    return undefined;
  }

  return scanner.result();
}
