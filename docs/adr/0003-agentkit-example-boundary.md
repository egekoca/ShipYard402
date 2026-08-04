# ADR-0003: AgentKit EIP-712 example is not a production payment

Status: Accepted — updates document section 13 and source G17.

The official `eip712-full-flow.ts` uses `MockMerchantGateway` and a random wallet. It validates adapter shape, not a live GOAT payment. Mainnet merchant and payer flows must use verified `goatflow-*` SDK surfaces, real runtime capabilities, on-chain transfer reconciliation, and explorer evidence. Mock gateway usage is restricted to tests.
