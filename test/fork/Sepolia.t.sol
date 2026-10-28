// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "forge-std/Test.sol";
import "../../contracts/Nutshell.sol";
import "../../contracts/NutsToken.sol";
import "../../contracts/V4SwapAdapter.sol";
import "../mocks/Mocks.sol";

/**
 * The whole money path against the REAL Uniswap v4 deployment on Sepolia:
 * open a NUTS/ETH position -> real swaps -> collect -> split -> buyback burn -> rewards to ETH
 * -> decrease/close returns principal without touching the split.
 *
 * Addresses mirror server/config.ts (DEPLOY = "sepolia"). `npm run test:fork`.
 */
contract SepoliaForkTest is Test {
    string constant RPC = "https://ethereum-sepolia-rpc.publicnode.com";
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Full range for tickSpacing 60: TickMath.MIN/MAX_TICK (+/-887272) rounded in to a multiple of 60.
    int24 constant LO = -887220;
    int24 constant HI = 887220;
    // 1 ETH = 1,000,000 NUTS: price(token1/token0) = 1e6, sqrt = 1000, times 2^96.
    uint160 constant SQRT_PRICE = 79228162514264337593543950336000;

    Nutshell hub;
    NutsToken nuts;
    V4SwapAdapter trader; // plays the market: its caller is this test
    PoolKey key;
    uint256 posId;

    receive() external payable {}

    function setUp() public {
        vm.createSelectFork(RPC);
        nuts = new NutsToken("Nutshell", "NUTS", 1_000_000_000e18);
        hub = new Nutshell();
        V4SwapAdapter adapter = new V4SwapAdapter(POOL_MANAGER, address(hub));
        trader = new V4SwapAdapter(POOL_MANAGER, address(this));
        MockSqueeks squeeks = new MockSqueeks();

        bytes32[] memory ks = new bytes32[](9);
        uint256[] memory vs = new uint256[](9);
        (ks[0], vs[0]) = ("nuts", uint256(uint160(address(nuts))));
        (ks[1], vs[1]) = ("positionManager", uint256(uint160(POSITION_MANAGER)));
        (ks[2], vs[2]) = ("permit2", uint256(uint160(PERMIT2)));
        (ks[3], vs[3]) = ("swapAdapter", uint256(uint160(address(adapter))));
        (ks[4], vs[4]) = ("squeekNft", uint256(uint160(address(squeeks))));
        (ks[5], vs[5]) = ("claimDelay", 600);
        (ks[6], vs[6]) = ("epochTtl", 180 days);
        (ks[7], vs[7]) = ("rewardsBps", 3000);
        (ks[8], vs[8]) = ("buybackBps", 2000);
        hub.setCfg(ks, vs);

        key = PoolKey(address(0), address(nuts), 3000, 60, address(0));
        PoolKey[] memory pools = new PoolKey[](1);
        bool[] memory allowed = new bool[](1);
        pools[0] = key;
        allowed[0] = true;
        hub.setPools(pools, allowed);
        IPoolManager(POOL_MANAGER).initialize(key, SQRT_PRICE);

        // Treasury capital: 11 ETH and 11M NUTS of principal.
        vm.deal(address(hub), 11 ether);
        nuts.transfer(address(hub), 11_000_000e18);

        // L = sqrt(10 ETH * 10M NUTS) = 1e22 at this price, full range.
        posId = hub.openPosition(key, LO, HI, 1e22, 11 ether, 11_000_000e18);
    }

    function _trade() internal {
        // This contract deployed NUTS and still holds most of the supply, so measure the buy
        // rather than reading the balance - selling the whole balance would crash the pool.
        vm.deal(address(this), 1 ether);
        uint256 before = nuts.balanceOf(address(this));
        trader.swap{value: 1 ether}(key, true, 1 ether, 1); // buy NUTS with 1 ETH
        uint256 got = nuts.balanceOf(address(this)) - before;
        nuts.transfer(address(trader), got);
        trader.swap(key, false, got, 1); // sell exactly that back
    }

    function _collect() internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = posId;
        hub.collectFees(ids);
    }

    function test_openPositionUsesOnlyPrincipal() public view {
        assertEq(IPositionManager(POSITION_MANAGER).ownerOf(posId), address(hub));
        (, bool live) = hub.position(posId);
        assertTrue(live);
        assertEq(hub.feesCollected(address(0)), 0);
        // Almost all of the 10 ETH went in; the unused part was swept back as free capital.
        assertApproxEqRel(address(hub).balance, 1 ether, 0.01e18);
    }

    function test_collectSplitsOnlyFees() public {
        _trade();
        uint256 supplyBefore = nuts.totalSupply();
        _collect();

        uint256 ethFee = hub.feesCollected(address(0));
        uint256 nutsFee = hub.feesCollected(address(nuts));
        // 0.3% of 1 ETH in, 0.3% of ~1M NUTS in.
        assertApproxEqRel(ethFee, 0.003 ether, 0.01e18, "eth fee");
        assertGt(nutsFee, 0, "nuts fee");

        assertEq(hub.rewardsBal(address(0)), ethFee * 3000 / 10000);
        assertEq(hub.buybackBal(address(0)), ethFee * 2000 / 10000);
        assertEq(hub.rewardsBal(address(nuts)), nutsFee * 3000 / 10000);
        assertEq(nuts.totalSupply(), supplyBefore - nutsFee * 2000 / 10000, "nuts share burned");

        // A second collect with no trades in between finds nothing: principal is never "fees".
        _collect();
        assertEq(hub.feesCollected(address(0)), ethFee);
        assertEq(hub.feesCollected(address(nuts)), nutsFee);
    }

    function test_buybackBurnsAndRewardsConvertToEth() public {
        _trade();
        _collect();

        uint256 buyEth = hub.buybackBal(address(0));
        uint256 supplyBefore = nuts.totalSupply();
        hub.swapBucket(1, key, true, buyEth, 1);
        assertEq(hub.buybackBal(address(0)), 0);
        assertLt(nuts.totalSupply(), supplyBefore, "bought NUTS burned");

        uint256 rewardNuts = hub.rewardsBal(address(nuts));
        uint256 rewardEthBefore = hub.rewardsBal(address(0));
        hub.swapBucket(0, key, false, rewardNuts, 1);
        assertEq(hub.rewardsBal(address(nuts)), 0);
        assertGt(hub.rewardsBal(address(0)), rewardEthBefore, "rewards now ETH");
    }

    function test_swapCannotSpendPrincipal() public {
        _trade();
        _collect();
        uint256 buyEth = hub.buybackBal(address(0));
        vm.expectRevert("insufficient");
        hub.swapBucket(1, key, true, buyEth + 1, 1);
    }

    function test_decreaseAndCloseReturnPrincipalNotRevenue() public {
        _trade();
        _collect();
        uint256 ethFee = hub.feesCollected(address(0));
        uint256 rewardsBefore = hub.rewardsBal(address(0));
        uint256 freeBefore = hub.freeBalance(address(0));

        hub.decreasePosition(posId, 5e21, 0, 0);
        assertEq(hub.feesCollected(address(0)), ethFee, "no new fees booked");
        assertEq(hub.rewardsBal(address(0)), rewardsBefore, "principal never split");
        assertApproxEqRel(hub.freeBalance(address(0)) - freeBefore, 5 ether, 0.01e18, "half came back");

        hub.closePosition(posId, 0, 0);
        (, bool live) = hub.position(posId);
        assertFalse(live);
        assertEq(hub.rewardsBal(address(0)), rewardsBefore);
    }

    function test_nonOperatorCannotTouchPositions() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("operator");
        hub.decreasePosition(posId, 1, 0, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert("operator");
        hub.swapBucket(1, key, true, 1, 1);
    }

    /// Free capital can be swapped (rebalance, accumulate SQK); the buckets cannot be reached.
    function test_treasurySwapSpendsFreeCapitalOnly() public {
        _trade();
        _collect();
        uint256 nutsBefore = nuts.balanceOf(address(hub));
        uint256 rewardsBefore = hub.rewardsBal(address(0));
        hub.swapTreasury(key, true, 0.1 ether, 1);
        assertGt(nuts.balanceOf(address(hub)), nutsBefore, "bought with free ETH");
        assertEq(hub.rewardsBal(address(0)), rewardsBefore, "rewards untouched");

        uint256 free = hub.freeBalance(address(0));
        vm.expectRevert(bytes("free"));
        hub.swapTreasury(key, true, free + 1, 1);
    }

    function test_anyoneCanCollect() public {
        _trade();
        vm.prank(address(0xC0FFEE));
        _collect();
        assertGt(hub.feesCollected(address(0)), 0);
    }
}
