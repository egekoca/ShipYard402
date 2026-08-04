# ADR-0012: Non-upgradeable append-only run registry

Status: Accepted — expands document section 17.

`ShipyardRunRegistry` is non-upgradeable and stores immutable run attestations. `runId` and customer payment proof are single-use. Version, policy, evidence, signed-tool root, expiry, requester, Shipyard agent, customer payment and tool spend are bound by EIP-712. Any relayer may submit a signature from an authorized attestor. Pause stops only new records; historical records are unchanged. Retesting always creates a new run.
