import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode <= 299;
}

export function hashCanonical(value: JsonValue): `0x${string}` {
  return hashText(canonicalJson(value));
}

export function hashText(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON numbers are not supported');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(',')}}`;
}
