// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Base.t.sol";

/// The tree scripts/lib/merkle.ts builds must be the tree Nutshell._verify accepts.
/// Regenerate the fixture with `npm run fixture:merkle` after touching either side.
contract MerkleFixtureTest is Base {
    function test_typescriptTreeClaimsOnChain() public {
        string memory json = vm.readFile("test/fixtures/merkle.json");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint256 total = vm.parseJsonUint(json, ".total");
        uint256[] memory ids = vm.parseJsonUintArray(json, ".ids");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        bytes32[][] memory proofs = new bytes32[][](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            proofs[i] = vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
            squeeks.mint(address(uint160(0x1000 + i)), ids[i]);
        }

        _fundEthFees(10 ether); // 3 ETH of rewards
        hub.postEpoch(root, uint128(total), 1);
        vm.warp(block.timestamp + 600);

        uint256 paid = hub.claim(0, ids, amounts, proofs);
        assertEq(paid, total, "every entry claimed, nothing more");
        assertEq(hub.epochReserved(), 0);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(address(uint160(0x1000 + i)).balance, amounts[i]);
        }
    }
}
