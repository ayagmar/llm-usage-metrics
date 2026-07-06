import { describe, expect, it } from 'vitest';

import {
  AntigravityProtoDecodeError,
  getFirstProtoLengthDelimitedField,
  getFirstProtoStringField,
  getFirstProtoVarintField,
  readAntigravityProtoFields,
} from '../../src/sources/antigravity/antigravity-proto-reader.js';

function encodeVarint(value: number): number[] {
  return encodeBigVarint(BigInt(value));
}

function encodeBigVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let remainingValue = value;

  do {
    const nextByte = Number(remainingValue & 0x7fn);
    remainingValue /= 128n;
    bytes.push(remainingValue === 0n ? nextByte : nextByte | 0x80);
  } while (remainingValue > 0n);

  return bytes;
}

function encodeFieldKey(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeVarintField(fieldNumber: number, value: number): number[] {
  return [...encodeFieldKey(fieldNumber, 0), ...encodeVarint(value)];
}

function encodeLengthDelimitedField(fieldNumber: number, value: number[]): number[] {
  return [...encodeFieldKey(fieldNumber, 2), ...encodeVarint(value.length), ...value];
}

function encodeStringField(fieldNumber: number, value: string): number[] {
  return encodeLengthDelimitedField(fieldNumber, [...new TextEncoder().encode(value)]);
}

describe('antigravity proto reader', () => {
  it('reads single-byte and multi-byte varints', () => {
    const fields = readAntigravityProtoFields(
      new Uint8Array([...encodeVarintField(1, 7), ...encodeVarintField(2, 300)]),
    );

    expect(getFirstProtoVarintField(fields, 1)).toBe(7);
    expect(getFirstProtoVarintField(fields, 2)).toBe(300);
    expect(getFirstProtoVarintField(fields, 3)).toBeUndefined();
  });

  it('reads length-delimited strings and nested messages', () => {
    const nestedMessage = encodeStringField(19, 'gemini-3-pro');
    const fields = readAntigravityProtoFields(
      new Uint8Array([
        ...encodeStringField(3, 'session-label'),
        ...encodeLengthDelimitedField(1, nestedMessage),
      ]),
    );
    const nestedBytes = getFirstProtoLengthDelimitedField(fields, 1);

    expect(getFirstProtoStringField(fields, 3)).toBe('session-label');
    expect(nestedBytes).toBeDefined();

    const nestedFields = readAntigravityProtoFields(nestedBytes ?? new Uint8Array());
    expect(getFirstProtoStringField(nestedFields, 19)).toBe('gemini-3-pro');
  });

  it('keeps repeated fields in insertion order', () => {
    const fields = readAntigravityProtoFields(
      new Uint8Array([...encodeVarintField(5, 1), ...encodeVarintField(5, 2)]),
    );

    expect(fields.get(5)).toEqual([
      { wireType: 'varint', value: 1 },
      { wireType: 'varint', value: 2 },
    ]);
  });

  it('rejects unsupported wire types', () => {
    expect(() => readAntigravityProtoFields(new Uint8Array([...encodeFieldKey(1, 5), 0]))).toThrow(
      AntigravityProtoDecodeError,
    );
    expect(() => readAntigravityProtoFields(new Uint8Array([...encodeFieldKey(1, 5), 0]))).toThrow(
      'Unsupported protobuf wire type: 5',
    );
  });

  it('rejects field zero', () => {
    expect(() => readAntigravityProtoFields(new Uint8Array([0]))).toThrow(
      'Protobuf field number must be positive',
    );
  });

  it('rejects truncated varints and length-delimited fields', () => {
    expect(() => readAntigravityProtoFields(new Uint8Array([0x08, 0x80]))).toThrow(
      'Truncated protobuf varint',
    );
    expect(() =>
      readAntigravityProtoFields(new Uint8Array([...encodeFieldKey(1, 2), 3, 1, 2])),
    ).toThrow('Truncated protobuf length-delimited field');
  });

  it('rejects overlong and unsafe varints', () => {
    expect(() => readAntigravityProtoFields(new Uint8Array(Array(11).fill(0x80)))).toThrow(
      'Protobuf varint is too long',
    );
    expect(() =>
      readAntigravityProtoFields(
        new Uint8Array([
          ...encodeFieldKey(1, 0),
          ...encodeBigVarint(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        ]),
      ),
    ).toThrow('Protobuf varint exceeds safe integer range');
  });
});
