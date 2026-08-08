export interface EvidencePublisherPort {
  publish(content: string): Promise<`ipfs://${string}`>;
}

/**
 * Publishes to a local Kubo node's HTTP API (docker-compose service `ipfs`). Adding is
 * content-addressed and idempotent -- publishing the same bytes twice (e.g. on a resumed
 * pipeline attempt) returns the same CID, so this needs no checkpoint guard of its own.
 */
export function createKuboEvidencePublisher(apiUrl: string): EvidencePublisherPort {
  return {
    async publish(content) {
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'application/json' }), 'evidence.json');
      const response = await fetch(new URL('/api/v0/add?pin=true&cid-version=1', apiUrl), {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`IPFS publish failed: ${response.status} ${body}`);
      }
      const result = (await response.json()) as Readonly<{ Hash?: string }>;
      if (!result.Hash) throw new Error('IPFS publish returned no CID');
      return `ipfs://${result.Hash}`;
    },
  };
}
