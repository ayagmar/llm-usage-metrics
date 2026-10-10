import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PricingOverrideSource,
  loadPricingOverrides,
} from '../../src/pricing/pricing-override-source.js';
import type { ModelPricing, PricingSource } from '../../src/pricing/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function fakeDelegate(pricingByModel: Record<string, ModelPricing>): PricingSource {
  return {
    resolveModelAlias: (model) => model.toLowerCase(),
    getPricing: (model) => pricingByModel[model.toLowerCase()],
  };
}

describe('PricingOverrideSource', () => {
  it('returns override pricing when the model name matches', () => {
    const override = new Map<string, ModelPricing>([
      ['claude-opus-4-8', { inputPer1MUsd: 12, outputPer1MUsd: 60 }],
    ]);
    const delegate = fakeDelegate({
      'claude-opus-4-8': { inputPer1MUsd: 15, outputPer1MUsd: 75 },
    });
    const source = new PricingOverrideSource(override, delegate);

    expect(source.getPricing('Claude-Opus-4-8')).toEqual({
      inputPer1MUsd: 12,
      outputPer1MUsd: 60,
    });
  });

  it('falls back to the delegate for models without an override', () => {
    const override = new Map<string, ModelPricing>();
    const delegate = fakeDelegate({
      'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 },
    });
    const source = new PricingOverrideSource(override, delegate);

    expect(source.getPricing('gpt-4.1')).toEqual({ inputPer1MUsd: 2, outputPer1MUsd: 8 });
  });

  it('skips delegate alias resolution for overridden models so the override wins', () => {
    const override = new Map<string, ModelPricing>([
      ['custom-internal-model', { inputPer1MUsd: 1, outputPer1MUsd: 2 }],
    ]);
    const delegate: PricingSource = {
      resolveModelAlias: () => 'some-other-model',
      getPricing: () => undefined,
    };
    const source = new PricingOverrideSource(override, delegate);

    expect(source.resolveModelAlias('custom-internal-model')).toBe('custom-internal-model');
    expect(source.getPricing('custom-internal-model')).toEqual({
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
    });
  });

  it('preserves optional cache and reasoning fields from overrides', () => {
    const override = new Map<string, ModelPricing>([
      [
        'claude-opus-4-8',
        {
          inputPer1MUsd: 12,
          outputPer1MUsd: 60,
          cacheReadPer1MUsd: 1.2,
          cacheWritePer1MUsd: 18.75,
          reasoningPer1MUsd: 0,
          reasoningBilling: 'included-in-output',
        },
      ],
    ]);
    const source = new PricingOverrideSource(override, fakeDelegate({}));

    expect(source.getPricing('claude-opus-4-8')).toEqual({
      inputPer1MUsd: 12,
      outputPer1MUsd: 60,
      cacheReadPer1MUsd: 1.2,
      cacheWritePer1MUsd: 18.75,
      reasoningPer1MUsd: 0,
      reasoningBilling: 'included-in-output',
    });
  });

  it('delegates alias resolution for models without an override', () => {
    const override = new Map<string, ModelPricing>();
    const delegate: PricingSource = {
      resolveModelAlias: (model) => `resolved-${model}`,
      getPricing: () => undefined,
    };
    const source = new PricingOverrideSource(override, delegate);

    expect(source.resolveModelAlias('gpt-4.1')).toBe('resolved-gpt-4.1');
  });
});

describe('loadPricingOverrides', () => {
  it('loads and normalizes a valid override file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          'claude-opus-4-8': {
            inputPer1MUsd: 12,
            outputPer1MUsd: 60,
            cacheWritePer1MUsd: 15,
            cacheWrite1hPer1MUsd: 24,
          },
          'My-Internal-Model': {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
            cacheReadPer1MUsd: 0.5,
          },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.size).toBe(2);
    expect(overrides.get('claude-opus-4-8')).toEqual({
      inputPer1MUsd: 12,
      outputPer1MUsd: 60,
      cacheWritePer1MUsd: 15,
      cacheWrite1hPer1MUsd: 24,
    });
    // keys are lowercased so lookups are case-insensitive
    expect(overrides.get('my-internal-model')).toEqual({
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      cacheReadPer1MUsd: 0.5,
    });
  });

  it('preserves zero and numeric-string rates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-optional-rates-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          'zero-rates': {
            inputPer1MUsd: 0,
            outputPer1MUsd: '0',
            cacheReadPer1MUsd: 0,
            cacheWritePer1MUsd: '0',
            reasoningPer1MUsd: 0,
          },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.get('zero-rates')).toEqual({
      inputPer1MUsd: 0,
      outputPer1MUsd: 0,
      cacheReadPer1MUsd: 0,
      cacheWritePer1MUsd: 0,
      reasoningPer1MUsd: 0,
    });
  });

  it('preserves a valid reasoningBilling value', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-good-billing-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          'with-separate-billing': {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
            reasoningPer1MUsd: 3,
            reasoningBilling: 'separate',
          },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.get('with-separate-billing')).toEqual({
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      reasoningPer1MUsd: 3,
      reasoningBilling: 'separate',
    });
  });

  async function writeOverrides(models: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-invalid-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');
    await writeFile(filePath, JSON.stringify(models), 'utf8');
    return filePath;
  }

  it('fails naming each invalid entry instead of dropping it silently', async () => {
    const filePath = await writeOverrides({
      models: {
        'blank-rate': { inputPer1MUsd: '   ', outputPer1MUsd: 2 },
        'non-numeric': { inputPer1MUsd: 'free', outputPer1MUsd: 2 },
        'negative-output': { inputPer1MUsd: 1, outputPer1MUsd: '-2' },
        'missing-output': { inputPer1MUsd: 1 },
        'negative-optional': { inputPer1MUsd: 1, outputPer1MUsd: 2, cacheReadPer1MUsd: -1 },
        'typo-key': { inputPer1MUsd: 1, outputPer1MUsd: 2, cacheReadPer1M: 0.1 },
        'bad-billing': { inputPer1MUsd: 1, outputPer1MUsd: 2, reasoningBilling: 'not-a-mode' },
        'not-an-object': 3,
        '   ': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
        'good-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
    });

    const error = await loadPricingOverrides(filePath).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    for (const expected of [
      '"blank-rate": inputPer1MUsd must be a non-negative number',
      '"non-numeric": inputPer1MUsd must be a non-negative number',
      '"negative-output": outputPer1MUsd must be a non-negative number',
      '"missing-output": outputPer1MUsd is required',
      '"negative-optional": cacheReadPer1MUsd must be a non-negative number',
      '"typo-key": unknown key "cacheReadPer1M"',
      '"bad-billing": reasoningBilling must be "included-in-output" or "separate"',
      '"not-an-object": expected an object of per-1M-token USD rates',
      'model names must be non-empty',
      'valid keys: inputPer1MUsd, outputPer1MUsd',
    ]) {
      expect(message).toContain(expected);
    }
    expect(message).not.toContain('good-model');
  });

  it('fails when the file has no models object', async () => {
    const filePath = await writeOverrides({ note: 'no models here' });

    await expect(loadPricingOverrides(filePath)).rejects.toThrow(
      'expected a JSON object with a "models" object',
    );
  });
});
