# ADR-0014: Discover payment assets and capabilities at runtime

Status: Accepted — updates document section 31 environment examples.

Production origin, merchant ID, token contracts, decimals, recipient, limits, fees and enabled capabilities are environment- and merchant-specific. No token is inferred from documentation examples. Quotes require a verified capability snapshot sourced from an authenticated API, challenge, QuickPay manifest, or reviewed portal record. If unavailable, the API returns a fail-closed 503 and creates no fake payment order.
