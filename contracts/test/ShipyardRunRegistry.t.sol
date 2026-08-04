// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShipyardRunRegistry} from "../src/ShipyardRunRegistry.sol";
import {TestBase} from "./TestBase.sol";

contract ShipyardRunRegistryTest is TestBase {
    ShipyardRunRegistry internal registry;
    uint256 internal constant ATTESTOR_KEY = 0xA11CE;
    uint256 internal constant BAD_ATTESTOR_KEY = 0xB0B;
    address internal attestor;
    address internal requester = address(0x1234);
    address internal shipyardAgent = address(0x402);
    address internal customerToken = address(0x1001);
    address internal toolToken = address(0x1002);

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ShipyardRunRegistry(address(this));
        attestor = vm.addr(ATTESTOR_KEY);
        registry.setAttestor(attestor, true);
    }

    function test_RecordRunStoresImmutableAttestation() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(1)), bytes32(uint256(11)));
        registry.recordRun(a, _sign(a, ATTESTOR_KEY));

        ShipyardRunRegistry.RunAttestation memory stored = registry.getRun(a.runId);
        assertTrue(registry.isRunRecorded(a.runId));
        assertEq(stored.targetVersionHash, a.targetVersionHash);
        assertEq(stored.policyHash, a.policyHash);
        assertEq(stored.customerPayment, a.customerPayment);
        assertEq(registry.paymentProofRun(a.customerPaymentProofHash), a.runId);
    }

    function test_DuplicateRunIdReverts() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(2)), bytes32(uint256(12)));
        bytes memory signature = _sign(a, ATTESTOR_KEY);
        registry.recordRun(a, signature);

        vm.expectRevert(abi.encodeWithSelector(ShipyardRunRegistry.RunAlreadyRecorded.selector, a.runId));
        registry.recordRun(a, signature);
    }

    function test_CustomerPaymentProofCannotFundTwoRuns() public {
        ShipyardRunRegistry.RunAttestation memory first = _attestation(bytes32(uint256(3)), bytes32(uint256(13)));
        ShipyardRunRegistry.RunAttestation memory second = _attestation(bytes32(uint256(4)), bytes32(uint256(13)));
        registry.recordRun(first, _sign(first, ATTESTOR_KEY));

        bytes memory secondSignature = _sign(second, ATTESTOR_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(
                ShipyardRunRegistry.PaymentProofAlreadyUsed.selector,
                first.customerPaymentProofHash,
                first.runId
            )
        );
        registry.recordRun(second, secondSignature);
    }

    function test_UnauthorizedSignatureReverts() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(5)), bytes32(uint256(15)));
        address badSigner = vm.addr(BAD_ATTESTOR_KEY);
        bytes memory badSignature = _sign(a, BAD_ATTESTOR_KEY);
        vm.expectRevert(abi.encodeWithSelector(ShipyardRunRegistry.UnauthorizedAttestor.selector, badSigner));
        registry.recordRun(a, badSignature);
    }

    function test_MissingVersionAndPolicyAreRejected() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(6)), bytes32(uint256(16)));
        a.targetVersionHash = bytes32(0);
        bytes memory missingVersionSignature = _sign(a, ATTESTOR_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(ShipyardRunRegistry.RequiredFieldMissing.selector, bytes32("targetVersionHash"))
        );
        registry.recordRun(a, missingVersionSignature);

        a = _attestation(bytes32(uint256(7)), bytes32(uint256(17)));
        a.policyHash = bytes32(0);
        bytes memory missingPolicySignature = _sign(a, ATTESTOR_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(ShipyardRunRegistry.RequiredFieldMissing.selector, bytes32("policyHash"))
        );
        registry.recordRun(a, missingPolicySignature);
    }

    function test_PauseStopsNewWritesButPreservesOldRecords() public {
        ShipyardRunRegistry.RunAttestation memory first = _attestation(bytes32(uint256(8)), bytes32(uint256(18)));
        registry.recordRun(first, _sign(first, ATTESTOR_KEY));
        registry.pause();

        ShipyardRunRegistry.RunAttestation memory second = _attestation(bytes32(uint256(9)), bytes32(uint256(19)));
        bytes memory secondSignature = _sign(second, ATTESTOR_KEY);
        vm.expectRevert();
        registry.recordRun(second, secondSignature);

        ShipyardRunRegistry.RunAttestation memory stored = registry.getRun(first.runId);
        assertEq(stored.evidenceRoot, first.evidenceRoot);
    }

    function test_OnlyOwnerCanRotateAttestorsAndPause() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.setAttestor(address(0xCAFE), true);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.pause();
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new ShipyardRunRegistry(address(0));
    }

    function test_SignatureCannotReplayAcrossRegistryDomains() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(10)), bytes32(uint256(20)));
        bytes memory signatureForFirstRegistry = _sign(a, ATTESTOR_KEY);
        ShipyardRunRegistry otherRegistry = new ShipyardRunRegistry(address(this));
        otherRegistry.setAttestor(attestor, true);

        vm.expectRevert();
        otherRegistry.recordRun(a, signatureForFirstRegistry);
    }

    function test_TamperingBoundEvidenceInvalidatesSignature() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(11)), bytes32(uint256(21)));
        bytes memory signature = _sign(a, ATTESTOR_KEY);
        a.evidenceRoot = keccak256("tampered-evidence");

        vm.expectRevert();
        registry.recordRun(a, signature);
    }

    function test_InvalidTimesAreRejected() public {
        ShipyardRunRegistry.RunAttestation memory future = _attestation(bytes32(uint256(12)), bytes32(uint256(22)));
        future.completedAt = uint64(block.timestamp + 1);
        bytes memory futureSignature = _sign(future, ATTESTOR_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(ShipyardRunRegistry.InvalidCompletionTime.selector, future.completedAt)
        );
        registry.recordRun(future, futureSignature);

        ShipyardRunRegistry.RunAttestation memory expired = _attestation(bytes32(uint256(13)), bytes32(uint256(23)));
        expired.expiresAt = uint64(block.timestamp);
        bytes memory expiredSignature = _sign(expired, ATTESTOR_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShipyardRunRegistry.InvalidExpiry.selector,
                expired.completedAt,
                expired.expiresAt
            )
        );
        registry.recordRun(expired, expiredSignature);
    }

    function test_ToolSpendRequiresSeparateTokenIdentity() public {
        ShipyardRunRegistry.RunAttestation memory a = _attestation(bytes32(uint256(14)), bytes32(uint256(24)));
        a.toolSpendToken = address(0);
        bytes memory signature = _sign(a, ATTESTOR_KEY);

        vm.expectRevert(abi.encodeWithSelector(ShipyardRunRegistry.InvalidAddress.selector, bytes32("toolSpendToken")));
        registry.recordRun(a, signature);
    }

    function testFuzz_ValidAttestationCanBeRecorded(
        bytes32 runId,
        bytes32 versionHash,
        bytes32 policyHash,
        bytes32 paymentProofHash,
        uint128 customerPayment,
        uint64 lifetime
    ) public {
        vm.assume(runId != bytes32(0));
        vm.assume(versionHash != bytes32(0));
        vm.assume(policyHash != bytes32(0));
        vm.assume(paymentProofHash != bytes32(0));
        vm.assume(customerPayment > 0);
        vm.assume(lifetime > 0 && lifetime < 365 days);

        ShipyardRunRegistry.RunAttestation memory a = _attestation(runId, paymentProofHash);
        a.targetVersionHash = versionHash;
        a.policyHash = policyHash;
        a.customerPayment = customerPayment;
        a.expiresAt = uint64(block.timestamp) + lifetime;
        registry.recordRun(a, _sign(a, ATTESTOR_KEY));
        assertTrue(registry.isRunRecorded(runId));
    }

    function _attestation(bytes32 runId, bytes32 paymentProofHash)
        internal
        view
        returns (ShipyardRunRegistry.RunAttestation memory)
    {
        return ShipyardRunRegistry.RunAttestation({
            runId: runId,
            targetAgentId: 184,
            targetServiceId: keccak256("service:market-signal"),
            targetVersionHash: keccak256("version:v1"),
            policyHash: keccak256("policy:release-gate:v1"),
            customerPaymentProofHash: paymentProofHash,
            toolReceiptRoot: keccak256("tool-receipts"),
            evidenceRoot: keccak256("evidence"),
            evidenceURI: "ipfs://bafybeishipyard402evidence",
            requester: requester,
            shipyardAgent: shipyardAgent,
            customerPaymentToken: customerToken,
            toolSpendToken: toolToken,
            customerPayment: 5_000_000,
            toolSpend: 1_800_000,
            completedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 30 days),
            result: ShipyardRunRegistry.Result.FAIL
        });
    }

    function _sign(ShipyardRunRegistry.RunAttestation memory a, uint256 privateKey)
        internal
        returns (bytes memory)
    {
        bytes32 digest = registry.hashAttestation(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
