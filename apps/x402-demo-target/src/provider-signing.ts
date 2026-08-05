import { createHash } from 'node:crypto';

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * Lets this demo target cryptographically attest to its own responses, independent of whatever
 * Shipyard's own orchestrator/fetch-client claims happened. See
 * @shipyard402/protected-delivery-runner's provider-signature.ts for why this matters: without
 * it, a compromised or buggy client could fabricate "the target rejected the replay" without ever
 * really talking to the target.
 */
export function createProviderSigner(privateKey: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(privateKey);
}

export async function signResponseBody(account: PrivateKeyAccount, bodyText: string): Promise<`0x${string}`> {
  const hash = `0x${createHash('sha256').update(bodyText).digest('hex')}` as `0x${string}`;
  return account.signMessage({ message: { raw: hash } });
}
