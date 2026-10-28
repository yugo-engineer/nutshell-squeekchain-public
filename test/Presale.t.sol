// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "forge-std/Test.sol";
import "../contracts/NutsPresale.sol";
import "../contracts/NutsToken.sol";

contract PresaleTest is Test {
    NutsPresale sale;
    NutsToken nuts;
    address treasury = makeAddr("treasury");
    address operator = makeAddr("operator");
    address holder = makeAddr("holder"); // in the Squeeks snapshot
    address holder2 = makeAddr("holder2");
    address stranger = makeAddr("stranger");

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant ETH_USD = 2_000e8; // $2,000 / ETH -> $500 = 0.25 ETH, $3,500 = 1.75 ETH
    bytes32 root;

    function setUp() public {
        sale = new NutsPresale(treasury);
        sale.setOperator(operator);
        nuts = new NutsToken("Nutshell", "NUTS", SUPPLY);
        vm.startPrank(operator);
        // the doc: $350k FDV, $500-$3,500, phase 1 = 10%, phase 2 = 8.57%, one hour each
        sale.configure(SUPPLY, 350_000, 500, 3_500, SUPPLY / 10, (SUPPLY * 857) / 10_000, 1 hours, 1 hours);
        sale.setEthUsd(ETH_USD);
        root = _node(_leaf(holder), _leaf(holder2));
        sale.setWhitelistRoot(root);
        vm.stopPrank();
        vm.deal(holder, 100 ether);
        vm.deal(holder2, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ---- merkle helpers (OpenZeppelin double-hash, sorted pairs) ----
    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _node(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(address a) internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = a == holder ? _leaf(holder2) : _leaf(holder);
    }

    /// The operator opens phase 1 with a contract call; phase 2 follows on its own.
    function _start() internal {
        vm.prank(operator);
        sale.startPhase1();
    }

    function _none() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    // ---- phases and timing ----
    function test_phasesRunOnTheClock() public {
        assertEq(sale.phase(), 0);
        _start();
        assertEq(sale.phase(), 1);
        vm.warp(block.timestamp + 1 hours);
        assertEq(sale.phase(), 2);
        vm.warp(block.timestamp + 1 hours);
        assertEq(sale.phase(), 3);
    }

    function test_startNeedsRateAndWhitelist() public {
        NutsPresale s = new NutsPresale(treasury);
        s.configure(SUPPLY, 350_000, 500, 3_500, SUPPLY / 10, (SUPPLY * 857) / 10_000, 1 hours, 1 hours);
        vm.expectRevert(bytes("rate"));
        s.startPhase1();
        s.setEthUsd(ETH_USD);
        vm.expectRevert("whitelist");
        s.startPhase1();
        vm.prank(stranger);
        vm.expectRevert("operator");
        s.startPhase1();
    }

    function test_notOpenBeforeStart() public {
        vm.prank(holder);
        vm.expectRevert("closed");
        sale.buy{value: 1 ether}(_proof(holder));
    }

    // ---- phase 1: Squeeks holders ----
    function test_phase1NeedsTheSnapshot() public {
        _start();
        vm.prank(stranger);
        vm.expectRevert("not whitelisted");
        sale.buy{value: 1 ether}(_proof(holder));

        uint256 before = treasury.balance;
        vm.prank(holder);
        uint256 got = sale.buy{value: 1 ether}(_proof(holder));
        // $2,000 at $0.00035 = 5,714,285.71 NUTS
        assertApproxEqAbs(got, 5_714_285.714285714285714285e18, 1e6);
        assertEq(sale.owed(holder), got);
        assertEq(treasury.balance - before, 1 ether, "ETH goes straight to the treasury");
        assertEq(address(sale).balance, 0, "sale holds no ETH");
    }

    function test_walletLimits() public {
        _start();
        vm.prank(holder);
        vm.expectRevert(bytes("min"));
        sale.buy{value: 0.2 ether}(_proof(holder)); // $400
        vm.prank(holder);
        sale.buy{value: 0.25 ether}(_proof(holder)); // $500 ok
        vm.prank(holder);
        sale.buy{value: 1.5 ether}(_proof(holder)); // total $3,500 ok
        vm.prank(holder);
        vm.expectRevert(bytes("max"));
        sale.buy{value: 0.01 ether}(_proof(holder));
    }

    /// Limits are per wallet across BOTH phases.
    function test_limitCarriesIntoPhase2() public {
        _start();
        vm.prank(holder);
        sale.buy{value: 1.75 ether}(_proof(holder));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(holder);
        vm.expectRevert(bytes("max"));
        sale.buy{value: 0.25 ether}(_none());
    }

    // ---- sell-out ends a phase early ----
    function test_phase1SellOutStartsPhase2Immediately() public {
        // A tiny phase 1 (1,000,000 NUTS = $350) so one buyer sells it out.
        NutsPresale s = _small(1_000_000e18, 1_000_000e18);
        uint256 before = holder.balance;
        vm.prank(holder);
        uint256 got = s.buy{value: 0.25 ether}(_proof(holder)); // wants ~1.43M, gets 1M
        assertEq(got, 1_000_000e18);
        assertEq(s.phase(), 2, "sold out -> phase 2 now");
        // paid only for 1M NUTS = $350 = 0.175 ETH; the rest refunded
        assertEq(before - holder.balance, 0.175 ether);

        vm.prank(stranger);
        s.buy{value: 0.25 ether}(_none());
        (uint8 ph, uint64 phaseStart, uint64 phaseEnd,,,,,) = s.status();
        assertEq(ph, 3, "phase 2 sold out too");
        assertEq(phaseEnd - phaseStart, 1 hours);
    }

    // ---- roll-over ----
    function test_unsoldPhase1RollsIntoPhase2() public {
        _start();
        vm.prank(holder);
        uint256 p1 = sale.buy{value: 1 ether}(_proof(holder));
        vm.warp(block.timestamp + 1 hours); // phase 1 ends on time
        (, , , uint256 cap, , , , ) = sale.status();
        assertEq(cap, (SUPPLY * 857) / 10_000 + (SUPPLY / 10 - p1));
    }

    // ---- phase 2: open to anyone ----
    function test_phase2IsPublic() public {
        _start();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(stranger);
        uint256 got = sale.buy{value: 1 ether}(_none());
        assertGt(got, 0);
    }

    function test_closedAfterPhase2() public {
        _start();
        vm.warp(block.timestamp + 2 hours);
        vm.prank(stranger);
        vm.expectRevert("closed");
        sale.buy{value: 1 ether}(_none());
    }

    // ---- no soft cap: launch regardless, claim at TGE ----
    function test_claimAtTgeEvenIfUnderfilled() public {
        _start();
        vm.prank(holder);
        uint256 got = sale.buy{value: 1 ether}(_proof(holder));

        vm.prank(operator);
        vm.expectRevert("sale live");
        sale.openClaims(address(nuts));

        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        vm.expectRevert("fund first");
        sale.openClaims(address(nuts));

        nuts.transfer(address(sale), got + 1_000e18); // a little over-funded
        vm.prank(operator);
        sale.openClaims(address(nuts));

        vm.prank(holder);
        sale.claim();
        assertEq(nuts.balanceOf(holder), got, "100% at TGE, no vesting");
        vm.prank(holder);
        vm.expectRevert("nothing");
        sale.claim();

        vm.prank(operator);
        sale.sweep(address(nuts));
        assertEq(nuts.balanceOf(treasury), 1_000e18, "excess back to treasury");
    }

    function test_sweepNeverTouchesOwed() public {
        _start();
        vm.prank(holder);
        uint256 got = sale.buy{value: 1 ether}(_proof(holder));
        vm.warp(block.timestamp + 2 hours);
        nuts.transfer(address(sale), got);
        vm.prank(operator);
        sale.openClaims(address(nuts));
        vm.prank(operator);
        vm.expectRevert("nothing");
        sale.sweep(address(nuts));
    }

    // ---- controls ----
    function test_termsFreezeAtStart() public {
        _start();
        vm.prank(operator);
        vm.expectRevert("started");
        sale.configure(SUPPLY, 1, 1, 1, 1, 1, 1, 1);
        vm.prank(operator);
        vm.expectRevert("started");
        sale.startPhase1();
    }

    function test_onlyOwnerMovesTheTreasury() public {
        vm.prank(operator);
        vm.expectRevert("owner");
        sale.setTreasury(operator);
        vm.prank(stranger);
        vm.expectRevert("operator");
        sale.setEthUsd(1);
    }

    function _small(uint256 p1Cap, uint256 p2Cap) internal returns (NutsPresale s) {
        s = new NutsPresale(treasury);
        s.configure(SUPPLY, 350_000, 1, 3_500, p1Cap, p2Cap, 1 hours, 1 hours);
        s.setEthUsd(ETH_USD);
        s.setWhitelistRoot(root);
        s.startPhase1();
    }
}
