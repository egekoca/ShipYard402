// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function assume(bool condition) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertFalse(bool value) internal pure {
        require(!value, "assertFalse failed");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "bytes32 not equal");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "uint256 not equal");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "address not equal");
    }
}
