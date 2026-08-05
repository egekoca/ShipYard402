// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShipyardTestToken} from "../src/ShipyardTestToken.sol";
import {TestBase} from "./TestBase.sol";

contract ShipyardTestTokenTest is TestBase {
    ShipyardTestToken internal token;
    address internal owner = address(this);
    address internal holder = address(0x1234);

    function setUp() public {
        token = new ShipyardTestToken(owner);
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
}
