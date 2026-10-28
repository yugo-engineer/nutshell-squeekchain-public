// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Base.t.sol";

contract RewardsTest is Base {
    // Squeek #1 (power-weighted) earns 2 ETH, Squeek #2 earns 1 ETH, in epoch 0.
    uint256 constant A1 = 2 ether;
    uint256 constant A2 = 1 ether;
    bytes32 l1;
    bytes32 l2;
    bytes32 root;

    function setUp() public override {
        super.setUp();
        squeeks.mint(alice, 1);
        squeeks.mint(bob, 2);
        _fundEthFees(10 ether); // rewards bucket = 3 ETH
        l1 = _leaf(0, 1, A1);
        l2 = _leaf(0, 2, A2);
        root = _node(l1, l2);
    }

    function _post() internal returns (uint256 id) {
        id = hub.postEpoch(root, uint128(A1 + A2), 123);
    }

    function _claim1() internal {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        ids[0] = 1;
        amts[0] = A1;
        proofs[0] = _one(l2);
        hub.claim(0, ids, amts, proofs);
    }

    function test_postReservesFromRewardsBucket() public {
        _post();
        assertEq(hub.rewardsBal(address(0)), 0);
        assertEq(hub.epochReserved(), 3 ether);
        // reserved ETH is no longer free capital either
        assertEq(hub.freeBalance(address(0)), 5 ether);
    }

    function test_cannotPostMoreThanBucket() public {
        vm.expectRevert("rewards");
        hub.postEpoch(root, 3 ether + 1, 1);
    }

    function test_claimPaysCurrentOwner() public {
        _post();
        vm.warp(block.timestamp + 600);
        _claim1();
        assertEq(alice.balance, A1);
        assertEq(hub.rewardsPaid(), A1);
        assertEq(hub.epochReserved(), A2);
    }

    function test_claimBeforeDelayReverts() public {
        _post();
        vm.expectRevert("window");
        _claim1();
    }

    function test_doubleClaimReverts() public {
        _post();
        vm.warp(block.timestamp + 600);
        _claim1();
        vm.expectRevert("claimed");
        _claim1();
    }

    /// The transfer exploit the spec warns about: claim, sell the Squeek, buyer claims again.
    /// The bit is keyed by (epoch, squeekId), so the second claim reverts whoever owns it.
    function test_transferCannotDoubleClaim() public {
        _post();
        vm.warp(block.timestamp + 600);
        _claim1();
        squeeks.transfer(1, bob);
        vm.expectRevert("claimed");
        _claim1();
    }

    /// Unclaimed rewards travel with the NFT: whoever owns the Squeek at claim time is paid.
    function test_rewardsTravelWithTheNft() public {
        _post();
        squeeks.transfer(1, bob);
        vm.warp(block.timestamp + 600);
        _claim1();
        assertEq(bob.balance, A1);
        assertEq(alice.balance, 0);
    }

    function test_wrongAmountFailsProof() public {
        _post();
        vm.warp(block.timestamp + 600);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        ids[0] = 1;
        amts[0] = A1 + 1;
        proofs[0] = _one(l2);
        vm.expectRevert("proof");
        hub.claim(0, ids, amts, proofs);
    }

    function test_burnedSqueekCannotClaimAndRollsForward() public {
        _post();
        squeeks.burn(1); // merged away after the snapshot
        vm.warp(block.timestamp + 600);
        vm.expectRevert("ERC721NonexistentToken");
        _claim1();

        vm.warp(block.timestamp + 180 days);
        hub.closeEpoch(0);
        assertEq(hub.rewardsBal(address(0)), 3 ether, "all unclaimed back in rewards");
        assertEq(hub.epochReserved(), 0);
    }

    function test_closeOnlyAfterExpiry() public {
        _post();
        vm.expectRevert(bytes("live"));
        hub.closeEpoch(0);
    }

    function test_cancelDuringReviewWindowOnly() public {
        _post();
        hub.cancelEpoch(0);
        assertEq(hub.rewardsBal(address(0)), 3 ether);

        _post(); // epoch 1
        vm.warp(block.timestamp + 600);
        vm.expectRevert("final");
        hub.cancelEpoch(1);
    }

    function test_overclaimingRootIsCapped() public {
        // A bad root promising 2 + 1 ETH but posted with total 2 ETH.
        hub.postEpoch(root, uint128(A1), 1);
        vm.warp(block.timestamp + 600);
        _claim1();
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        ids[0] = 2;
        amts[0] = A2;
        proofs[0] = _one(l1);
        vm.expectRevert("overclaim");
        hub.claim(0, ids, amts, proofs);
    }

    /// A Squeek owned by a contract that rejects ETH blocks only its own claim.
    function test_hostileOwnerOnlyBlocksItself() public {
        EthRefuser r = new EthRefuser();
        squeeks.transfer(1, address(r));
        _post();
        vm.warp(block.timestamp + 600);
        vm.expectRevert(bytes("eth"));
        _claim1();

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        ids[0] = 2;
        amts[0] = A2;
        proofs[0] = _one(l1);
        hub.claim(0, ids, amts, proofs);
        assertEq(bob.balance, A2);
    }

    function test_claimWorksWhilePaused() public {
        _post();
        _set("paused", 1);
        vm.warp(block.timestamp + 600);
        _claim1();
        assertEq(alice.balance, A1);
    }
}
