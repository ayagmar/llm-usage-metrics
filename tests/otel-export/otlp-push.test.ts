import { describe, expect, it } from 'vitest';

import { parseOtlpHeaders } from '../../src/otel-export/otlp-push.js';

describe('parseOtlpHeaders', () => {
  it('reads k=v pairs, trims around them and percent-decodes values', () => {
    expect(parseOtlpHeaders(' api-key = a%3Db%2Cc ,authorization=Bearer%20x,')).toEqual({
      'api-key': 'a=b,c',
      authorization: 'Bearer x',
    });
  });

  it('compares names case-insensitively, the later entry winning', () => {
    expect(parseOtlpHeaders('Authorization=old,AUTHORIZATION=new,Content-Type=text/plain')).toEqual(
      {
        authorization: 'new',
        'content-type': 'text/plain',
      },
    );
  });

  it('keeps a raw = inside a value', () => {
    expect(parseOtlpHeaders('token=abc==')).toEqual({ token: 'abc==' });
  });

  it('is empty when the variable is unset or blank', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders('  ')).toEqual({});
  });

  it.each([
    ['secret-value', 'entry 1 is not key=value'],
    ['a=1,bad key=secret-value', 'entry 2 is not key=value'],
    ['key=secret-value%', 'the value of key is not valid percent-encoding'],
    ['key=secret-value%0A', 'the value of key has a line break or NUL'],
  ])('rejects %s without quoting the value', (value, message) => {
    expect(() => parseOtlpHeaders(value)).toThrow(message);

    try {
      parseOtlpHeaders(value);
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
});
