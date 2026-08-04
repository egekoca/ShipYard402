// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShipyardRunRegistry} from "../src/ShipyardRunRegistry.sol";
import {TestBase} from "./TestBase.sol";

contract ShipyardRunRegistryInvariantTest is TestBase {
    ShipyardRunRegistry internal registry;
    bytes32 internal constant RUN_ID = keccak256("immutable-run");
    bytes32 internal constant PAYMENT_PROOF_HASH = keccak256("payment");
    bytes32 internal expectedEvidenceRoot;
    bytes32 internal expectedAttestationHash;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ShipyardRunRegistry(address(this));
        uint256 key = 0xA11CE;
        registry.setAttestor(vm.addr(key), true);

        expectedEvidenceRoot = keccak256("immutable-evidence");
        ShipyardRunRegistry.RunAttestation memory a = ShipyardRunRegistry.RunAttestation({
            runId: RUN_ID,
            targetAgentId: 184,
            targetServiceId: keccak256("service"),
            targetVersionHash: keccak256("version"),
            policyHash: keccak256("policy"),
            customerPaymentProofHash: PAYMENT_PROOF_HASH,
            toolReceiptRoot: keccak256("tools"),
            evidenceRoot: expectedEvidenceRoot,
            evidenceURI: "ipfs://immutable",
            requester: address(0x1234),
            shipyardAgent: address(0x402),
            customerPaymentToken: address(0x1001),
            toolSpendToken: address(0x1001),
            customerPayment: 5_000_000,
            toolSpend: 1_000_000,
            completedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 30 days),
            result: ShipyardRunRegistry.Result.PASS
        });
        expectedAttestationHash = keccak256(abi.encode(a));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.hashAttestation(a));
        registry.recordRun(a, abi.encodePacked(r, s, v));
    }

    function invariant_RecordedRunRemainsImmutable() public view {
        ShipyardRunRegistry.RunAttestation memory stored = registry.getRun(RUN_ID);
        assertTrue(registry.isRunRecorded(RUN_ID));
        assertEq(stored.evidenceRoot, expectedEvidenceRoot);
        assertEq(stored.runId, RUN_ID);
        assertEq(keccak256(abi.encode(stored)), expectedAttestationHash);
    }

    function invariant_PaymentProofBindingRemainsSingleUse() public view {
        assertEq(registry.paymentProofRun(PAYMENT_PROOF_HASH), RUN_ID);
    }
}
