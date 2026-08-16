// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ShipyardTestToken
/// @notice A mintable ERC-20 for exercising the x402 payment flow on GOAT Testnet3 before real GOAT
/// Flow merchant onboarding is complete. Owner-only mint, unlimited supply -- this has no value and
/// must never be deployed to Mainnet or treated as a real settlement asset.
///
/// Implements EIP-3009 `transferWithAuthorization` so it can act as the settlement asset for the
/// x402 `exact` EVM scheme: a payer signs a transfer authorization off-chain (EIP-712), and any
/// party holding gas submits it. The `(authorizer, nonce)` pair is consumed on first use, which is
/// what makes an x402 payment replay revert on-chain rather than settle twice.
contract ShipyardTestToken is ERC20, Ownable, EIP712 {
    /// keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    /// @notice True once an authorization nonce has been used by `authorizer`; a replay reverts.
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();

    /// @dev The EIP-712 domain name/version an x402 payer reproduces to sign an authorization this
    /// token will accept. Kept in sync with the requirements `extra` the resource server advertises.
    constructor(address initialOwner)
        ERC20("Shipyard Testnet Token", "SHIPTEST")
        Ownable(initialOwner)
        EIP712("Shipyard Testnet Token", "1")
    {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Whether `nonce` has already been consumed by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice EIP-3009: execute a transfer the `from` account authorized off-chain.
    /// @dev Anyone may submit; the signature is what authorizes the movement of `from`'s balance.
    /// Consuming the nonce before the transfer makes a replayed authorization revert.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != from) revert InvalidAuthorizationSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
