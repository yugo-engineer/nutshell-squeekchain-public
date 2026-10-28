// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "../../contracts/Nutshell.sol";

/// Stands in for SqueekNFT: just ownerOf, mint, transfer and burn. A burned ID reverts in
/// ownerOf, exactly like an OpenZeppelin ERC-721 after a Squeek merge.
contract MockSqueeks {
    mapping(uint256 => address) internal _owner;

    function mint(address to, uint256 id) external {
        _owner[id] = to;
    }

    function transfer(uint256 id, address to) external {
        _owner[id] = to;
    }

    function burn(uint256 id) external {
        delete _owner[id];
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = _owner[id];
        require(o != address(0), "ERC721NonexistentToken");
    }
}

/// Exposes the split so unit tests can fund buckets without a pool. Production code paths
/// reach _split only through collectFees.
contract NutshellHarness is Nutshell {
    function split(address token, uint256 amount) external {
        _split(token, amount);
    }
}

/// A contract that refuses ETH, to prove a hostile Squeek owner only blocks its own claim.
contract EthRefuser {
    receive() external payable {
        revert("no");
    }
}
