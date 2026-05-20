// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract MockLawbworldToken is ERC20, ERC20Burnable {
    uint256 public constant INITIAL_SUPPLY = 100_000_000_000 ether;

    constructor() ERC20("Mock Lawbworld", "mLAWB") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
