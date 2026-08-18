# BOT Chain go-live runbook

The BOT Chain integration is complete in code: the direct-merchant adapter (on-chain payment
verification, no merchant API), chain-968 network config, api-gateway adapter selection, the
payment-worker verification path, wallet switching, the directory chain filter, and onboarding
chain selection. What remains is on-chain deployment, which moves real testnet gas and must be run
by an operator holding the signer — not by the assistant.

Chain: BOT Chain testnet (`968`), RPC `https://rpc.bohr.life`, explorer `https://scan.bohr.life`.

## Prerequisites

- The compiled contracts (`contracts/out-solc/…ShipyardRunRegistry…` and
  `contracts/out/ShipyardTestToken.sol/ShipyardTestToken.json`) — already present.
- A disposable BOT-scoped deploy signer with testnet gas.

## Steps (operator-run; each deploy is fail-closed and idempotent)

1. **Create the deploy signer** (writes a 0600, gitignored key file; prints only the address):
   ```
   node scripts/testnet/create-wallet-botchain.mjs
   ```
   Produces `.local/testnet/botchain-testnet-wallet.json` scoped to `botchain-testnet-only` / 968.
   (Already generated: `0x0fb8aad3bDd981E47E8b7f914a88bcbAdDd31cE2`.)

2. **Fund that address** with BOT Chain testnet gas. A read-only balance check gates the deploy:
   until it holds gas, the deploy scripts stop before spending anything.

3. **Deploy the registry**:
   ```
   node scripts/testnet/deploy-registry-botchain.mjs
   ```
   Writes `.local/testnet/shipyard-run-registry-botchain.json` with the deployed registry address.

4. **Deploy + mint the test token** (settlement asset for the BOT merchant flow):
   ```
   node scripts/testnet/deploy-test-token-botchain.mjs
   node scripts/testnet/mint-test-token-botchain.mjs
   ```

5. **Run a BOT-mode api-gateway** with these env values (private keys only in `.env`, never in chat):
   ```
   MERCHANT_ADAPTER=bot-chain-direct
   BOT_NETWORK_ENVIRONMENT=botChainTestnet
   BOTX402_MERCHANT_ID=…
   BOTX402_TOKEN_ADDRESS=<deployed test token>
   BOTX402_TOKEN_SYMBOL=… BOTX402_TOKEN_DECIMALS=…
   BOTX402_RECEIVING_ADDRESS=… BOTX402_MINIMUM_ATOMIC_AMOUNT=… BOTX402_MAXIMUM_ATOMIC_AMOUNT=…
   ```

6. **Point the orchestrator at BOT Chain** (it is already chain-agnostic in code):
   ```
   NETWORK=bot-chain-testnet
   BOTCHAIN_TESTNET_RPC_URL=https://rpc.bohr.life
   SHIPYARD_RUN_REGISTRY_ADDRESS=<deployed registry address>
   ```
   The attestor signer needs BOT gas to write attestations.

7. **List a BOT Chain target** in the directory: onboard a service through the app's form and pick
   **BOT Chain** in the settlement-chain selector (or onboard with `chainId: 968`). It then appears
   under the directory's **BOT Chain** filter tab.

## Safety

No command in the normal test/build workflow touches a chain. Steps 2–4 spend real testnet gas and
require the funded, BOT-scoped signer. Mainnet is intentionally out of scope
(`BOT_NETWORK_ENVIRONMENT` is locked to testnet).
