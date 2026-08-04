// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title ShipyardRunRegistry
/// @notice Append-only execution attestations. A record is not a general security certificate.
/// @dev The contract is deliberately non-upgradeable. Retests always use a new runId.
contract ShipyardRunRegistry is Ownable2Step, Pausable, EIP712 {
    enum Result {
        PASS,
        CONDITIONAL,
        FAIL,
        INCONCLUSIVE
    }

    struct RunAttestation {
        bytes32 runId;
        uint256 targetAgentId;
        bytes32 targetServiceId;
        bytes32 targetVersionHash;
        bytes32 policyHash;
        bytes32 customerPaymentProofHash;
        bytes32 toolReceiptRoot;
        bytes32 evidenceRoot;
        string evidenceURI;
        address requester;
        address shipyardAgent;
        address customerPaymentToken;
        address toolSpendToken;
        uint128 customerPayment;
        uint128 toolSpend;
        uint64 completedAt;
        uint64 expiresAt;
        Result result;
    }

    bytes32 public constant RUN_ATTESTATION_TYPEHASH = keccak256(
        "RunAttestation(bytes32 scopeHash,bytes32 evidenceHash,bytes32 economicsHash,bytes32 outcomeHash)"
    );
    bytes32 public constant RUN_SCOPE_TYPEHASH = keccak256(
        "RunScope(bytes32 runId,uint256 targetAgentId,bytes32 targetServiceId,bytes32 targetVersionHash,bytes32 policyHash,address requester,address shipyardAgent)"
    );
    bytes32 public constant RUN_EVIDENCE_TYPEHASH = keccak256(
        "RunEvidence(bytes32 customerPaymentProofHash,bytes32 toolReceiptRoot,bytes32 evidenceRoot,bytes32 evidenceURIHash)"
    );
    bytes32 public constant RUN_ECONOMICS_TYPEHASH = keccak256(
        "RunEconomics(address customerPaymentToken,address toolSpendToken,uint128 customerPayment,uint128 toolSpend)"
    );
    bytes32 public constant RUN_OUTCOME_TYPEHASH = keccak256(
        "RunOutcome(uint64 completedAt,uint64 expiresAt,uint8 result)"
    );

    uint256 public constant MAX_EVIDENCE_URI_BYTES = 512;

    mapping(bytes32 runId => RunAttestation attestation) private _runs;
    mapping(bytes32 runId => bool recorded) public isRunRecorded;
    mapping(bytes32 customerPaymentProofHash => bytes32 runId) public paymentProofRun;
    mapping(address attestor => bool authorized) public authorizedAttestors;

    error RunAlreadyRecorded(bytes32 runId);
    error PaymentProofAlreadyUsed(bytes32 paymentProofHash, bytes32 existingRunId);
    error UnauthorizedAttestor(address signer);
    error RequiredFieldMissing(bytes32 field);
    error InvalidAddress(bytes32 field);
    error InvalidCompletionTime(uint64 completedAt);
    error InvalidExpiry(uint64 completedAt, uint64 expiresAt);
    error InvalidEvidenceURI();
    error InvalidCustomerPayment();

    event AttestorAuthorizationChanged(address indexed attestor, bool authorized, address indexed changedBy);
    event RunRecorded(
        bytes32 indexed runId,
        uint256 indexed targetAgentId,
        bytes32 indexed targetVersionHash,
        Result result,
        bytes32 evidenceRoot,
        uint64 expiresAt,
        bytes32 customerPaymentProofHash,
        address attestor
    );

    constructor(address initialOwner) Ownable(initialOwner) EIP712("ShipyardRunRegistry", "1") {
        if (initialOwner == address(0)) revert InvalidAddress("initialOwner");
    }

    function setAttestor(address attestor, bool authorized) external onlyOwner {
        if (attestor == address(0)) revert InvalidAddress("attestor");
        authorizedAttestors[attestor] = authorized;
        emit AttestorAuthorizationChanged(attestor, authorized, msg.sender);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Records an immutable attestation. Any account may relay an authorized signature.
    function recordRun(RunAttestation calldata attestation, bytes calldata attestorSignature)
        external
        whenNotPaused
    {
        _validate(attestation);
        if (isRunRecorded[attestation.runId]) revert RunAlreadyRecorded(attestation.runId);

        bytes32 priorRun = paymentProofRun[attestation.customerPaymentProofHash];
        if (priorRun != bytes32(0)) {
            revert PaymentProofAlreadyUsed(attestation.customerPaymentProofHash, priorRun);
        }

        address signer = ECDSA.recover(hashAttestation(attestation), attestorSignature);
        if (!authorizedAttestors[signer]) revert UnauthorizedAttestor(signer);

        isRunRecorded[attestation.runId] = true;
        paymentProofRun[attestation.customerPaymentProofHash] = attestation.runId;
        _runs[attestation.runId] = attestation;

        emit RunRecorded(
            attestation.runId,
            attestation.targetAgentId,
            attestation.targetVersionHash,
            attestation.result,
            attestation.evidenceRoot,
            attestation.expiresAt,
            attestation.customerPaymentProofHash,
            signer
        );
    }

    function getRun(bytes32 runId) external view returns (RunAttestation memory) {
        return _runs[runId];
    }

    function hashAttestation(RunAttestation calldata attestation) public view returns (bytes32) {
        bytes32 scopeHash = keccak256(
            abi.encode(
                RUN_SCOPE_TYPEHASH,
                attestation.runId,
                attestation.targetAgentId,
                attestation.targetServiceId,
                attestation.targetVersionHash,
                attestation.policyHash,
                attestation.requester,
                attestation.shipyardAgent
            )
        );
        bytes32 evidenceHash = keccak256(
            abi.encode(
                RUN_EVIDENCE_TYPEHASH,
                attestation.customerPaymentProofHash,
                attestation.toolReceiptRoot,
                attestation.evidenceRoot,
                keccak256(bytes(attestation.evidenceURI))
            )
        );
        bytes32 economicsHash = keccak256(
            abi.encode(
                RUN_ECONOMICS_TYPEHASH,
                attestation.customerPaymentToken,
                attestation.toolSpendToken,
                attestation.customerPayment,
                attestation.toolSpend
            )
        );
        bytes32 outcomeHash = keccak256(
            abi.encode(
                RUN_OUTCOME_TYPEHASH,
                attestation.completedAt,
                attestation.expiresAt,
                uint8(attestation.result)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                RUN_ATTESTATION_TYPEHASH,
                scopeHash,
                evidenceHash,
                economicsHash,
                outcomeHash
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _validate(RunAttestation calldata attestation) private view {
        if (attestation.runId == bytes32(0)) revert RequiredFieldMissing("runId");
        if (attestation.targetServiceId == bytes32(0)) revert RequiredFieldMissing("targetServiceId");
        if (attestation.targetVersionHash == bytes32(0)) revert RequiredFieldMissing("targetVersionHash");
        if (attestation.policyHash == bytes32(0)) revert RequiredFieldMissing("policyHash");
        if (attestation.customerPaymentProofHash == bytes32(0)) {
            revert RequiredFieldMissing("customerPaymentProofHash");
        }
        if (attestation.toolReceiptRoot == bytes32(0)) revert RequiredFieldMissing("toolReceiptRoot");
        if (attestation.evidenceRoot == bytes32(0)) revert RequiredFieldMissing("evidenceRoot");
        if (attestation.requester == address(0)) revert InvalidAddress("requester");
        if (attestation.shipyardAgent == address(0)) revert InvalidAddress("shipyardAgent");
        if (attestation.customerPaymentToken == address(0)) revert InvalidAddress("customerPaymentToken");
        if (attestation.toolSpend > 0 && attestation.toolSpendToken == address(0)) {
            revert InvalidAddress("toolSpendToken");
        }
        if (attestation.customerPayment == 0) revert InvalidCustomerPayment();
        if (attestation.completedAt > block.timestamp) revert InvalidCompletionTime(attestation.completedAt);
        if (attestation.expiresAt <= attestation.completedAt || attestation.expiresAt <= block.timestamp) {
            revert InvalidExpiry(attestation.completedAt, attestation.expiresAt);
        }
        uint256 uriLength = bytes(attestation.evidenceURI).length;
        if (uriLength == 0 || uriLength > MAX_EVIDENCE_URI_BYTES) revert InvalidEvidenceURI();
    }
}
