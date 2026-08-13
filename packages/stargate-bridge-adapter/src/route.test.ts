import { describe, expect, it } from 'vitest';

import {
  GOAT_TO_BNB_STARGATE_ROUTES,
  GOAT_TO_BNB_USDC_STARGATE_ROUTE,
  GOAT_TO_BNB_USDT_STARGATE_ROUTE,
  goatToBnbStargateRoute,
} from './route.js';

describe('goatToBnbStargateRoute', () => {
  it('resolves the USDC route by its source symbol', () => {
    expect(goatToBnbStargateRoute('USDC')).toBe(GOAT_TO_BNB_USDC_STARGATE_ROUTE);
    expect(goatToBnbStargateRoute('USDT')).toBe(GOAT_TO_BNB_USDT_STARGATE_ROUTE);
  });

  it('throws on an unsupported asset rather than defaulting to the wrong token', () => {
    // Silent fallback here would bridge a different asset than intended -- must fail loudly.
    expect(() => goatToBnbStargateRoute('DAI')).toThrow(/No GOAT->BNB Stargate route/);
  });
});

describe('GOAT_TO_BNB_USDC_STARGATE_ROUTE (on-chain-verified constants)', () => {
  const route = GOAT_TO_BNB_USDC_STARGATE_ROUTE;

  it('bridges GOAT USDC to BNB USDC on the correct endpoints', () => {
    expect(route.sourceAsset).toMatchObject({ network: 'eip155:2345', symbol: 'USDC', decimals: 6 });
    expect(route.destinationAsset).toMatchObject({ network: 'eip155:56', symbol: 'USDC', decimals: 18 });
    expect(route.sourceEndpointId).toBe(30361);
    expect(route.destinationEndpointId).toBe(30102);
    expect(route.sharedDecimals).toBe(6);
  });

  it('pins the pool addresses whose live token() was verified to be USDC', () => {
    expect(route.sourceOftAddress).toBe('0xbbA60da06c2c5424f03f7434542280FCAd453d10');
    expect(route.destinationOftAddress).toBe('0x962Bd449E630b0d928f308Ce63f1A21F02576057');
    expect(route.sourceAsset.tokenAddress).toBe('0x3022b87ac063DE95b1570F46f5e470F8B53112D8');
    expect(route.destinationAsset.tokenAddress).toBe('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  });

  it('never crosses wires with the USDT route', () => {
    expect(GOAT_TO_BNB_STARGATE_ROUTES.USDC.id).not.toBe(GOAT_TO_BNB_STARGATE_ROUTES.USDT.id);
    expect(route.sourceOftAddress).not.toBe(GOAT_TO_BNB_USDT_STARGATE_ROUTE.sourceOftAddress);
  });
});
