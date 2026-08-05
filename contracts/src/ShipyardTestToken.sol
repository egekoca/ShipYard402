// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ShipyardTestToken
/// @notice A mintable ERC-20 for exercising the wallet-pay flow on GOAT Testnet3 before real GOAT
/// Flow merchant onboarding is complete. Owner-only mint, unlimited supply -- this has no value
/// and must never be deployed to Mainnet or treated as a real settlement asset.
contract ShipyardTestToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Shipyard Testnet Token", "SHIPTEST") Ownable(initialOwner) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
