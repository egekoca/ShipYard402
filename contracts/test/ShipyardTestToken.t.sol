// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShipyardTestToken} from "../src/ShipyardTestToken.sol";
import {TestBase} from "./TestBase.sol";

contract ShipyardTestTokenTest is TestBase {
    ShipyardTestToken internal token;
    address internal owner = address(this);
    address internal holder = address(0x1234);

    // A fixed disposable payer key; its address is the authorizer in the EIP-3009 cases.
    uint256 internal constant PAYER_KEY = 0xA11CE;
    address internal payer;
    address internal recipient = address(0xBEEF);

    bytes32 internal constant TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        token = new ShipyardTestToken(owner);
        payer = vm.addr(PAYER_KEY);
    }

    function test_OwnerCanMint() public {
        token.mint(holder, 100 ether);
        assertEq(token.balanceOf(holder), 100 ether);
        assertEq(token.totalSupply(), 100 ether);
    }

    function test_NonOwnerCannotMint() public {
        vm.prank(holder);
        vm.expectRevert();
        token.mint(holder, 1 ether);
    }

    function test_TransferMovesBalance() public {
        token.mint(owner, 50 ether);
        token.transfer(holder, 20 ether);
        assertEq(token.balanceOf(owner), 30 ether);
        assertEq(token.balanceOf(holder), 20 ether);
    }

    // --- EIP-3009 -----------------------------------------------------------------------------

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Shipyard Testnet Token")),
                keccak256(bytes("1")),
                block.chainid,
                address(token)
            )
        );
    }

    function _sign(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_TransferWithAuthorization_Settles() public {
        token.mint(payer, 1000);
        vm.warp(1000);
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(PAYER_KEY, payer, recipient, 400, 500, 2000, nonce);

        // Anyone (here, owner) may submit the payer's signed authorization.
        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);

        assertEq(token.balanceOf(recipient), 400);
        assertEq(token.balanceOf(payer), 600);
        assertTrue(token.authorizationState(payer, nonce));
    }

    function test_Replay_SameNonce_Reverts() public {
        token.mint(payer, 1000);
        vm.warp(1000);
        bytes32 nonce = bytes32(uint256(2));
        bytes memory sig = _sign(PAYER_KEY, payer, recipient, 400, 500, 2000, nonce);

        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);

        // The whole point: replaying the identical signed authorization reverts on-chain, so an
        // x402 payment can never settle twice. This is what a protected server relies on.
        vm.expectRevert(abi.encodeWithSelector(ShipyardTestToken.AuthorizationAlreadyUsed.selector));
        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);
    }

    function test_NotYetValid_Reverts() public {
        token.mint(payer, 1000);
        vm.warp(100);
        bytes32 nonce = bytes32(uint256(3));
        bytes memory sig = _sign(PAYER_KEY, payer, recipient, 400, 500, 2000, nonce);
        vm.expectRevert(abi.encodeWithSelector(ShipyardTestToken.AuthorizationNotYetValid.selector));
        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);
    }

    function test_Expired_Reverts() public {
        token.mint(payer, 1000);
        vm.warp(3000);
        bytes32 nonce = bytes32(uint256(4));
        bytes memory sig = _sign(PAYER_KEY, payer, recipient, 400, 500, 2000, nonce);
        vm.expectRevert(abi.encodeWithSelector(ShipyardTestToken.AuthorizationExpired.selector));
        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);
    }

    function test_WrongSigner_Reverts() public {
        token.mint(payer, 1000);
        vm.warp(1000);
        bytes32 nonce = bytes32(uint256(5));
        // Signed by a different key (0xB0B) but claiming `payer` as `from`.
        bytes memory sig = _sign(0xB0B, payer, recipient, 400, 500, 2000, nonce);
        vm.expectRevert(abi.encodeWithSelector(ShipyardTestToken.InvalidAuthorizationSignature.selector));
        token.transferWithAuthorization(payer, recipient, 400, 500, 2000, nonce, sig);
    }

    function test_TamperedValue_Reverts() public {
        token.mint(payer, 1000);
        vm.warp(1000);
        bytes32 nonce = bytes32(uint256(6));
        // Signature covers value=400; submitter tries to move 900. Digest differs -> recovers a
        // different address than `from`.
        bytes memory sig = _sign(PAYER_KEY, payer, recipient, 400, 500, 2000, nonce);
        vm.expectRevert(abi.encodeWithSelector(ShipyardTestToken.InvalidAuthorizationSignature.selector));
        token.transferWithAuthorization(payer, recipient, 900, 500, 2000, nonce, sig);
    }
}
