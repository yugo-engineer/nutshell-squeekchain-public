// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "forge-std/Test.sol";
import "../contracts/Nutshell.sol";
import "../contracts/NutsToken.sol";
import "./mocks/Mocks.sol";

abstract contract Base is Test {
    NutshellHarness hub;
    NutsToken nuts;
    MockSqueeks squeeks;

    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public virtual {
        hub = new NutshellHarness();
        nuts = new NutsToken("Nutshell", "NUTS", 1_000_000_000e18);
        squeeks = new MockSqueeks();
        _set("operator", uint256(uint160(operator)));
        _set("nuts", uint256(uint160(address(nuts))));
        _set("squeekNft", uint256(uint160(address(squeeks))));
        _set("claimDelay", 600);
        _set("epochTtl", 180 days);
        // The suites below were written against a 50/30/20 split; pin it so they keep proving
        // the same money path. Split.t.sol covers the configurable bounds.
        _set("rewardsBps", 3000);
        _set("buybackBps", 2000);
    }

    function _set(bytes32 k, uint256 v) internal {
        bytes32[] memory ks = new bytes32[](1);
        uint256[] memory vs = new uint256[](1);
        ks[0] = k;
        vs[0] = v;
        hub.setCfg(ks, vs);
    }

    /// Credits `amount` of ETH fees: the ETH really arrives, then goes through the split.
    function _fundEthFees(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(hub).call{value: amount}("");
        require(ok);
        hub.split(address(0), amount);
    }

    // ---- two-level Merkle helpers, OpenZeppelin double-hash leaves, sorted pairs ----
    function _leaf(uint256 epochId, uint256 id, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epochId, id, amount))));
    }

    function _node(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _one(bytes32 p) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = p;
    }
}
