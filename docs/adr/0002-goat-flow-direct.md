# ADR-0002: Use public GOAT Flow ERC20_DIRECT

Status: Accepted — updates document sections 6, 13.3 and 31.

The document described DIRECT as default and DELEGATE as optional. Current official GOAT Flow documentation identifies the public merchant flow as `ERC20_DIRECT`; operator-provisioned callback compatibility is outside public onboarding. The MVP therefore implements `ERC20_DIRECT` only. Callback/legacy DELEGATE behavior remains disabled unless GOAT supplies and verifies an explicit production contract.

This preserves the original requirement to avoid a mandatory DELEGATE dependency while removing an outdated capability assumption.
