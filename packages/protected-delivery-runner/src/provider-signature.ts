import { getBytes, verifyMessage } from 'ethers';

/**
 * A tool provider's response is, today, only ever checked by Shipyard's own fetch client and
 * runner -- a compromised or malicious version of either could fabricate a "the target rejected
 * the replay" result without ever really talking to the provider. When the provider signs its own
 * response body hash with a key registered ahead of time (DemoTargetConfig.providerSignerAddress),
 * that fabrication becomes detectable: the signature only verifies against a response the provider
 * itself actually produced. This does not require the provider to be a third party -- the value is
 * the same cryptographic non-repudiation regardless of who operates it.
 */
export function verifyResponseSignature(
  responseBodyHash: `0x${string}`,
  providerSignature: `0x${string}` | undefined,
  expectedSigner: `0x${string}`,
): boolean {
  if (!providerSignature) return false;
  try {
    const recovered = verifyMessage(getBytes(responseBodyHash), providerSignature);
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}
