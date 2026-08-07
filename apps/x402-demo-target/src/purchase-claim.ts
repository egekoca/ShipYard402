/**
 * The message a caller must sign (EIP-191 personal_sign) with the same wallet that broadcast the
 * payment, to prove they control the transaction's sender address before /purchase will honor a
 * claim for it. Kept in one place because apps/orchestrator-worker's fetch-purchase-client.ts
 * must produce byte-identical text for the signature to recover the expected address.
 */
export function purchaseClaimMessage(transactionHash: string): string {
  return `Shipyard402 x402-demo-target purchase claim: ${transactionHash.toLowerCase()}`;
}
