// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Base.t.sol";

contract SplitTest is Base {
    /// The three parts always sum to the fee exactly, and the dust lands in the treasury.
    function testFuzz_splitIsExact(uint128 amount) public {
        _fundEthFees(amount);
        uint256 r = hub.rewardsBal(address(0));
        uint256 b = hub.buybackBal(address(0));
        uint256 t = hub.treasuryRetained(address(0));
        assertEq(r + b + t, amount, "sum");
        assertEq(r, uint256(amount) * 3000 / 10000);
        assertEq(b, uint256(amount) * 2000 / 10000);
        assertEq(hub.freeBalance(address(0)), t, "treasury share is free capital");
    }

    function test_tinyFeeAllToTreasury() public {
        _fundEthFees(3);
        assertEq(hub.rewardsBal(address(0)), 0);
        assertEq(hub.buybackBal(address(0)), 0);
        assertEq(hub.treasuryRetained(address(0)), 3);
    }

    function test_zeroFeeIsNoop() public {
        hub.split(address(0), 0);
        assertEq(hub.feesCollected(address(0)), 0);
    }

    /// NUTS fees: the 20% is burned immediately and totalSupply really drops.
    function test_nutsBuybackShareBurnsOnArrival() public {
        uint256 fee = 1_000e18;
        nuts.transfer(address(hub), fee);
        uint256 supplyBefore = nuts.totalSupply();
        hub.split(address(nuts), fee);
        assertEq(nuts.totalSupply(), supplyBefore - 200e18, "burned");
        assertEq(hub.nutsBurned(), 200e18);
        assertEq(hub.buybackBal(address(nuts)), 0);
        assertEq(hub.rewardsBal(address(nuts)), 300e18);
        assertEq(nuts.balanceOf(address(hub)), 800e18);
    }

    // ---- the owner cannot reach the buckets ----
    function test_withdrawFreeCapitalOnly() public {
        _fundEthFees(10 ether); // 5 free, 3 rewards, 2 buyback
        hub.withdraw(address(0), alice, 5 ether);
        assertEq(alice.balance, 5 ether);
        vm.expectRevert("covered");
        hub.withdraw(address(0), alice, 1);
    }

    function test_principalDepositIsNotRevenue() public {
        vm.deal(address(this), 7 ether);
        (bool ok,) = address(hub).call{value: 7 ether}("");
        assertTrue(ok);
        assertEq(hub.feesCollected(address(0)), 0);
        assertEq(hub.rewardsBal(address(0)), 0);
        assertEq(hub.freeBalance(address(0)), 7 ether);
    }

    // ---- access ----
    function test_nonOwnerCannotConfigure() public {
        bytes32[] memory ks = new bytes32[](1);
        uint256[] memory vs = new uint256[](1);
        ks[0] = "operator";
        vs[0] = uint256(uint160(alice));
        vm.prank(alice);
        vm.expectRevert("operator");
        hub.setCfg(ks, vs);

        vm.prank(operator);
        vm.expectRevert("owner");
        hub.withdraw(address(0), operator, 0);
    }

    function test_cfgBounds() public {
        vm.expectRevert("claimDelay");
        _set("claimDelay", 31 days);
        vm.expectRevert("epochTtl");
        _set("epochTtl", 1 hours);
    }

    /// Any pool may be listed - with or without NUTS, hooked or not - by the operator too.
    function test_setPoolsAcceptsAnyPool() public {
        PoolKey[] memory ks = new PoolKey[](3);
        bool[] memory al = new bool[](3);
        ks[0] = PoolKey(address(0), address(nuts), 3000, 60, address(0xBEEF)); // hooked NUTS/ETH
        ks[1] = PoolKey(address(0x1111), address(0x2222), 500, 10, address(0)); // stock/stable, no NUTS
        ks[2] = PoolKey(address(0), address(0x3333), 3000, 60, address(0)); // SQK/ETH-style
        al[0] = al[1] = al[2] = true;
        vm.prank(operator);
        hub.setPools(ks, al);
        for (uint256 i; i < 3; ++i) assertTrue(hub.poolAllowed(keccak256(abi.encode(ks[i]))));

        PoolKey[] memory bad = new PoolKey[](1);
        bool[] memory one = new bool[](1);
        bad[0] = PoolKey(address(nuts), address(0), 3000, 60, address(0));
        one[0] = true;
        vm.expectRevert("order");
        hub.setPools(bad, one);

        vm.prank(alice);
        vm.expectRevert("operator");
        hub.setPools(ks, al);
    }

    // ---- the configurable split ----
    function test_splitFollowsConfig() public {
        _set("buybackBps", 1500); // lower the burn first: 35 + 20 would breach the 50% floor
        _set("rewardsBps", 3500); // the tokenomics doc: >=50 / <=35 / 15
        _fundEthFees(10 ether);
        assertEq(hub.rewardsBal(address(0)), 3.5 ether);
        assertEq(hub.buybackBal(address(0)), 1.5 ether);
        assertEq(hub.treasuryRetained(address(0)), 5 ether);
    }

    function test_splitBounds() public {
        _set("buybackBps", 0);
        vm.expectRevert("rewardsBps");
        _set("rewardsBps", 3501);
        _set("rewardsBps", 3500);
        vm.expectRevert("split");
        _set("buybackBps", 1501); // 35 + 15.01 > 50: treasury would drop below half
        _set("rewardsBps", 0);
        _set("buybackBps", 5000); // all-burn is allowed, treasury still 50%
    }

    function test_unsetSplitSendsEverythingToTreasury() public {
        _set("rewardsBps", 0);
        _set("buybackBps", 0);
        _fundEthFees(1 ether);
        assertEq(hub.treasuryRetained(address(0)), 1 ether);
    }

    // ---- operator powers ----
    function test_operatorSetsEconomicKeysOnly() public {
        bytes32[] memory ks = new bytes32[](1);
        uint256[] memory vs = new uint256[](1);
        ks[0] = "rewardsBps";
        vs[0] = 2500;
        vm.prank(operator);
        hub.setCfg(ks, vs);
        assertEq(hub.cfg("rewardsBps"), 2500);

        ks[0] = "swapAdapter";
        vs[0] = uint256(uint160(alice));
        vm.prank(operator);
        vm.expectRevert("owner key");
        hub.setCfg(ks, vs);

        ks[0] = "squeekNft";
        vm.prank(operator);
        vm.expectRevert("owner key");
        hub.setCfg(ks, vs);
    }

    function test_operatorPostsAndCancelsEpochs() public {
        _fundEthFees(10 ether);
        vm.prank(operator);
        hub.postEpoch(bytes32(uint256(1)), 1 ether, 1);
        vm.prank(operator);
        hub.cancelEpoch(0);
        assertEq(hub.rewardsBal(address(0)), 3 ether);
    }

    function test_sweepRewardsToTreasury() public {
        _fundEthFees(10 ether); // 3 rewards
        vm.prank(operator);
        hub.sweepRewards(address(0), 1 ether);
        assertEq(hub.rewardsBal(address(0)), 2 ether);
        assertEq(hub.freeBalance(address(0)), 6 ether, "swept ETH is free capital now");
        vm.prank(operator);
        vm.expectRevert("rewards");
        hub.sweepRewards(address(0), 2 ether + 1);
        vm.prank(alice);
        vm.expectRevert("operator");
        hub.sweepRewards(address(0), 1);
    }

    function test_swapCapBound() public {
        vm.expectRevert("maxSwapBps");
        _set("maxSwapBps", 10_001);
        _set("maxSwapBps", 2500);
        assertEq(hub.cfg("maxSwapBps"), 2500);
    }

    function test_twoStepOwnership() public {
        hub.transferOwnership(alice);
        assertEq(hub.owner(), address(this));
        vm.prank(bob);
        vm.expectRevert("pending");
        hub.acceptOwnership();
        vm.prank(alice);
        hub.acceptOwnership();
        assertEq(hub.owner(), alice);
    }

    function test_pausedBlocksSpendingNotExits() public {
        _set("paused", 1);
        PoolKey memory k = PoolKey(address(0), address(nuts), 3000, 60, address(0));
        vm.prank(operator);
        vm.expectRevert("paused");
        hub.swapBucket(0, k, true, 1, 1);
        vm.expectRevert("paused");
        hub.postEpoch(bytes32(uint256(1)), 1, 1);
    }
}
