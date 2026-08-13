import type { TransactionHash } from '@shipyard402/x402-payments';

import type { LayerZeroDelivery, LayerZeroScanPort } from './ports.js';

export class LayerZeroScanClient implements LayerZeroScanPort {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #sourceEndpointId: number;
  readonly #destinationEndpointId: number;

  constructor(
    input: Readonly<{
      sourceEndpointId: number;
      destinationEndpointId: number;
      baseUrl?: string;
      fetchImplementation?: typeof fetch;
    }>,
  ) {
    this.#sourceEndpointId = input.sourceEndpointId;
    this.#destinationEndpointId = input.destinationEndpointId;
    this.#baseUrl = new URL(input.baseUrl ?? 'https://scan.layerzero-api.com/v1/');
    this.#fetch = input.fetchImplementation ?? fetch;
  }

  async getDelivery(sourceTransactionHash: TransactionHash, signal?: AbortSignal): Promise<LayerZeroDelivery | null> {
    const response = await this.#fetch(
      new URL(`messages/tx/${encodeURIComponent(sourceTransactionHash)}`, this.#baseUrl),
      signal ? { signal } : undefined,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LayerZero Scan returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    const messages = collectMessages(body);
    const message = messages.find((candidate) => {
      const sourceEndpointId = readNumber(candidate, [
        ['source', 'eid'],
        ['source', 'endpointId'],
        ['pathway', 'srcEid'],
        ['srcEid'],
      ]);
      const destinationEndpointId = readNumber(candidate, [
        ['destination', 'eid'],
        ['destination', 'endpointId'],
        ['pathway', 'dstEid'],
        ['dstEid'],
      ]);
      return sourceEndpointId === this.#sourceEndpointId && destinationEndpointId === this.#destinationEndpointId;
    });
    if (!message) return null;

    const status = readString(message, [['status', 'name'], ['status']]) ?? 'INFLIGHT';
    const destinationStatus = readString(message, [
      ['destination', 'status', 'name'],
      ['destination', 'status'],
    ]);
    const destinationTransactionHash = readString(message, [
      ['destination', 'tx', 'txHash'],
      ['destination', 'txHash'],
      ['destinationTxHash'],
    ]);
    const failureReason = readString(message, [
      ['error', 'message'],
      ['failureReason'],
      ['destination', 'error', 'message'],
    ]);
    const result: LayerZeroDelivery = {
      status,
      ...(destinationStatus ? { destinationStatus } : {}),
      ...(isHash(destinationTransactionHash) ? { destinationTransactionHash } : {}),
      ...(failureReason ? { failureReason } : {}),
    };
    return result;
  }
}

type JsonRecord = Record<string, unknown>;

function collectMessages(body: unknown): JsonRecord[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  const candidates = [body['data'], body['messages']];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate) && Array.isArray(candidate['messages'])) {
      return candidate['messages'].filter(isRecord);
    }
  }
  return hasMessageShape(body) ? [body] : [];
}

function hasMessageShape(value: JsonRecord): boolean {
  return value['source'] !== undefined || value['srcEid'] !== undefined || value['pathway'] !== undefined;
}

function readString(record: JsonRecord, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(record: JsonRecord, paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function readPath(record: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHash(value: string | undefined): value is TransactionHash {
  return value !== undefined && /^0x[a-fA-F0-9]{64}$/.test(value);
}
