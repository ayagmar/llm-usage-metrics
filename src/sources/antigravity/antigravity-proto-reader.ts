const VARINT_WIRE_TYPE = 0;
const FIXED64_WIRE_TYPE = 1;
const LENGTH_DELIMITED_WIRE_TYPE = 2;
const FIXED32_WIRE_TYPE = 5;
const FIXED64_BYTES = 8;
const FIXED32_BYTES = 4;
const FIELD_KEY_BASE = 8;
const LOW_7_BITS_MASK = 0x7f;
const CONTINUATION_BIT = 0x80;
const MAX_VARINT_BYTES = 10;

export type AntigravityProtoVarintField = {
  wireType: 'varint';
  value: number;
};

export type AntigravityProtoLengthDelimitedField = {
  wireType: 'length-delimited';
  value: Uint8Array;
};

export type AntigravityProtoField =
  AntigravityProtoVarintField | AntigravityProtoLengthDelimitedField;

export type AntigravityProtoFields = Map<number, AntigravityProtoField[]>;

export class AntigravityProtoDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AntigravityProtoDecodeError';
  }
}

function fail(message: string): never {
  throw new AntigravityProtoDecodeError(message);
}

function readByte(input: Uint8Array, offset: number): number {
  if (offset >= input.byteLength) {
    return fail('Truncated protobuf varint');
  }

  return input[offset];
}

/** Decodes a varint; `value` is undefined when it exceeds the safe integer range. */
function readVarintValue(
  input: Uint8Array,
  startOffset: number,
): { value: number | undefined; nextOffset: number } {
  let value = 0n;
  let shift = 0n;

  for (let byteIndex = 0; byteIndex < MAX_VARINT_BYTES; byteIndex++) {
    const byte = readByte(input, startOffset + byteIndex);
    value |= BigInt(byte & LOW_7_BITS_MASK) << shift;

    if ((byte & CONTINUATION_BIT) === 0) {
      const decoded = Number(value);

      return {
        value: Number.isSafeInteger(decoded) ? decoded : undefined,
        nextOffset: startOffset + byteIndex + 1,
      };
    }

    shift += 7n;
  }

  return fail('Protobuf varint is too long');
}

function readVarint(input: Uint8Array, startOffset: number): { value: number; nextOffset: number } {
  const { value, nextOffset } = readVarintValue(input, startOffset);

  if (value === undefined) {
    return fail('Protobuf varint exceeds safe integer range');
  }

  return { value, nextOffset };
}

function skipFixedBytes(input: Uint8Array, offset: number, byteCount: number): number {
  const endOffset = offset + byteCount;

  if (endOffset > input.byteLength) {
    return fail('Truncated protobuf fixed-width field');
  }

  return endOffset;
}

function appendField(
  fields: AntigravityProtoFields,
  fieldNumber: number,
  field: AntigravityProtoField,
): void {
  const existingFields = fields.get(fieldNumber);

  if (existingFields) {
    existingFields.push(field);
    return;
  }

  fields.set(fieldNumber, [field]);
}

export function readAntigravityProtoFields(inputValue: Uint8Array): AntigravityProtoFields {
  const input = inputValue;
  const fields: AntigravityProtoFields = new Map();
  let offset = 0;

  while (offset < input.byteLength) {
    const key = readVarint(input, offset);
    offset = key.nextOffset;

    const fieldNumber = Math.floor(key.value / FIELD_KEY_BASE);
    const wireType = key.value % FIELD_KEY_BASE;

    if (fieldNumber === 0) {
      return fail('Protobuf field number must be positive');
    }

    if (wireType === VARINT_WIRE_TYPE) {
      // 64-bit ids and hashes exceed Number's safe range; no usage field is that large, so
      // they are skipped instead of failing the whole message.
      const parsedValue = readVarintValue(input, offset);
      offset = parsedValue.nextOffset;

      if (parsedValue.value !== undefined) {
        appendField(fields, fieldNumber, { wireType: 'varint', value: parsedValue.value });
      }

      continue;
    }

    if (wireType === FIXED64_WIRE_TYPE || wireType === FIXED32_WIRE_TYPE) {
      offset = skipFixedBytes(
        input,
        offset,
        wireType === FIXED64_WIRE_TYPE ? FIXED64_BYTES : FIXED32_BYTES,
      );
      continue;
    }

    if (wireType === LENGTH_DELIMITED_WIRE_TYPE) {
      const length = readVarint(input, offset);
      offset = length.nextOffset;
      const endOffset = offset + length.value;

      if (endOffset > input.byteLength) {
        return fail('Truncated protobuf length-delimited field');
      }

      appendField(fields, fieldNumber, {
        wireType: 'length-delimited',
        value: input.slice(offset, endOffset),
      });
      offset = endOffset;
      continue;
    }

    return fail(`Unsupported protobuf wire type: ${wireType}`);
  }

  return fields;
}

export function getFirstProtoVarintField(
  fields: ReadonlyMap<number, readonly AntigravityProtoField[]>,
  fieldNumber: number,
): number | undefined {
  const field = fields.get(fieldNumber)?.find((candidate) => candidate.wireType === 'varint');
  return field?.wireType === 'varint' ? field.value : undefined;
}

export function getFirstProtoLengthDelimitedField(
  fields: ReadonlyMap<number, readonly AntigravityProtoField[]>,
  fieldNumber: number,
): Uint8Array | undefined {
  const field = fields
    .get(fieldNumber)
    ?.find((candidate) => candidate.wireType === 'length-delimited');
  return field?.wireType === 'length-delimited' ? field.value : undefined;
}

export function getFirstProtoStringField(
  fields: ReadonlyMap<number, readonly AntigravityProtoField[]>,
  fieldNumber: number,
): string | undefined {
  const bytes = getFirstProtoLengthDelimitedField(fields, fieldNumber);

  if (!bytes) {
    return undefined;
  }

  return new TextDecoder().decode(bytes);
}
