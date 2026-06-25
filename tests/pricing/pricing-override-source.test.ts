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
          'claude-opus-4-8': { inputPer1MUsd: 12, outputPer1MUsd: 60 },
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
    });
    // keys are lowercased so lookups are case-insensitive
    expect(overrides.get('my-internal-model')).toEqual({
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      cacheReadPer1MUsd: 0.5,
    });
  });

  it('drops entries with blank or non-numeric required rates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-blank-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          'blank-rate-model': { inputPer1MUsd: '   ', outputPer1MUsd: 2 },
          'non-numeric-model': { inputPer1MUsd: 'free', outputPer1MUsd: 2 },
          'good-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.size).toBe(1);
    expect(overrides.has('blank-rate-model')).toBe(false);
    expect(overrides.has('non-numeric-model')).toBe(false);
    expect(overrides.get('good-model')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
  });

  it('ignores invalid reasoningBilling values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-billing-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          'with-bad-billing': {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
            reasoningBilling: 'not-a-mode',
          },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.get('with-bad-billing')).toEqual({
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
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

  it('skips entries whose model name is blank', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-blank-key-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(
      filePath,
      JSON.stringify({
        models: {
          '   ': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
          'good-model': { inputPer1MUsd: 3, outputPer1MUsd: 4 },
        },
      }),
      'utf8',
    );

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.size).toBe(1);
    expect(overrides.get('good-model')).toEqual({ inputPer1MUsd: 3, outputPer1MUsd: 4 });
  });

  it('returns an empty map for a file with no models object', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pricing-overrides-empty-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'overrides.json');

    await writeFile(filePath, JSON.stringify({ note: 'no models here' }), 'utf8');

    const overrides = await loadPricingOverrides(filePath);

    expect(overrides.size).toBe(0);
  });
});
