// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Interfaces.sol";

/**
 * NutsPresale - the Genesis Presale. Two back-to-back, time-boxed phases, paid in ETH.
 *
 *   PHASE 1  Squeeks holders only (a Merkle snapshot of owners at a fixed block).
 *            Lasts p1Duration (1 hour) OR until p1Cap (10% of supply) is sold, whichever first.
 *   PHASE 2  Anyone. Starts the moment phase 1 ends and lasts p2Duration (1 hour) OR until its
 *            cap is sold. Its cap is p2Cap (8.57%) PLUS whatever phase 1 left unsold.
 *
 * There is no soft cap and no refund: whatever sells, sells, and Nutshell launches regardless.
 * Every wei goes straight to the treasury (the hub) in the same transaction - this contract never
 * holds ETH, so there is nothing here to steal or to get stuck.
 *
 * Pricing is in USD, from the doc: price = fdvUsd / totalSupply, per-wallet limits minUsd..maxUsd
 * across both phases. ETH is converted with ethUsdE8, a rate the operator sets (and may update
 * when phase 2 opens). Buyers receive NUTS at TGE: once the sale has ended and this contract is
 * funded with the sold amount, the operator opens claims and each buyer claims 100%.
 * Tokens that never sold are never sent here; anything above what buyers are owed can be swept
 * back to the treasury.
 */
contract NutsPresale {
    // ================================================================ roles
    address public owner;
    address public pendingOwner;
    address public operator;
    address public treasury;

    // ================================================================ terms (fixed at start)
    uint256 public totalSupplyTokens; // e.g. 1_000_000_000e18
    uint256 public fdvUsd; //            whole dollars, e.g. 350_000
    uint256 public minUsd; //            whole dollars, e.g. 500
    uint256 public maxUsd; //            whole dollars, e.g. 3_500
    uint256 public p1Cap; //             tokens, e.g. 10% of supply
    uint256 public p2Cap; //             tokens, e.g. 8.57% of supply (before phase-1 roll-over)
    uint64 public p1Duration; //         seconds
    uint64 public p2Duration; //         seconds

    // ================================================================ live state
    uint256 public ethUsdE8; //          USD per ETH with 8 decimals; operator-set
    bytes32 public whitelistRoot; //     Squeeks holders snapshot
    uint64 public start; //              0 until the operator calls startPhase1()
    uint64 public p1SoldOutAt; //        0 unless phase 1 sold out early
    uint64 public p2SoldOutAt;
    uint256 public p1Sold;
    uint256 public p2Sold;
    uint256 public totalRaisedWei;
    uint256 public totalOwed; //         sold and not yet claimed

    mapping(address => uint256) public usdSpent; // 18-decimal USD, both phases
    mapping(address => uint256) public owed; //     NUTS to claim at TGE
    mapping(address => uint256) public paidWei;

    address public token;
    bool public claimsOpen;
    uint256 private _lock = 1;

    // ================================================================ events
    event OwnerChanged(address indexed from, address indexed to);
    event OperatorSet(address indexed operator);
    event TreasurySet(address indexed treasury);
    event Configured(uint256 supply, uint256 fdvUsd, uint256 minUsd, uint256 maxUsd, uint256 p1Cap, uint256 p2Cap, uint64 p1Duration, uint64 p2Duration);
    event Started(uint64 start);
    event EthUsdSet(uint256 ethUsdE8);
    event WhitelistSet(bytes32 root);
    event Bought(address indexed buyer, uint8 indexed phase, uint256 paidWei, uint256 usd, uint256 tokens);
    event PhaseSoldOut(uint8 indexed phase, uint64 soldOutAt);
    event ClaimsOpened(address indexed token, uint256 owed);
    event Claimed(address indexed buyer, uint256 tokens);
    event Swept(address indexed token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || msg.sender == operator, "operator");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address treasury_) {
        require(treasury_ != address(0), "treasury");
        owner = msg.sender;
        treasury = treasury_;
        emit OwnerChanged(address(0), msg.sender);
        emit TreasurySet(treasury_);
    }

    // ================================================================ ownership + roles
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "pending");
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setOperator(address op) external onlyOwner {
        operator = op;
        emit OperatorSet(op);
    }

    /// Where the raise goes. Owner-only: this is the one address money flows to.
    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    // ================================================================ presale controls (operator)
    /// Sale terms. Frozen once the sale has started.
    function configure(
        uint256 supply,
        uint256 fdvUsd_,
        uint256 minUsd_,
        uint256 maxUsd_,
        uint256 p1Cap_,
        uint256 p2Cap_,
        uint64 p1Duration_,
        uint64 p2Duration_
    ) external onlyOperator {
        require(start == 0, "started");
        require(supply != 0 && fdvUsd_ != 0, "terms");
        require(minUsd_ <= maxUsd_ && maxUsd_ != 0, "limits");
        require(p1Cap_ + p2Cap_ <= supply, "caps");
        require(p1Duration_ != 0 && p2Duration_ != 0, "durations");
        (totalSupplyTokens, fdvUsd, minUsd, maxUsd) = (supply, fdvUsd_, minUsd_, maxUsd_);
        (p1Cap, p2Cap, p1Duration, p2Duration) = (p1Cap_, p2Cap_, p1Duration_, p2Duration_);
        emit Configured(supply, fdvUsd_, minUsd_, maxUsd_, p1Cap_, p2Cap_, p1Duration_, p2Duration_);
    }

    /**
     * Opens phase 1 NOW. The sale has no scheduled start - the operator starts it with this call,
     * once terms, rate and the Squeeks snapshot are in place. Phase 2 then opens by itself the
     * moment phase 1 ends (its hour is up or its cap sells out). Callable once.
     */
    function startPhase1() external onlyOperator {
        require(start == 0, "started");
        require(totalSupplyTokens != 0, "configure first");
        require(ethUsdE8 != 0, "rate");
        require(whitelistRoot != bytes32(0), "whitelist");
        start = uint64(block.timestamp);
        emit Started(start);
    }

    function setEthUsd(uint256 e8) external onlyOperator {
        require(e8 != 0, "rate");
        ethUsdE8 = e8;
        emit EthUsdSet(e8);
    }

    function setWhitelistRoot(bytes32 root) external onlyOperator {
        whitelistRoot = root;
        emit WhitelistSet(root);
    }

    // ================================================================ buying
    /**
     * Buys NUTS for msg.value ETH. Phase 1 needs a Merkle proof that msg.sender is in the Squeeks
     * snapshot; phase 2 ignores it. If the phase cap is reached mid-purchase the buyer gets the
     * remainder, pays only for it, and the rest of the ETH comes straight back.
     */
    function buy(bytes32[] calldata proof) external payable nonReentrant returns (uint256 tokens) {
        uint8 ph = phase();
        require(ph == 1 || ph == 2, "closed");
        require(ethUsdE8 != 0, "rate");
        if (ph == 1) require(_verify(proof, whitelistRoot, keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))), "not whitelisted");

        uint256 usd = msg.value * ethUsdE8 / 1e8; // 18-decimal USD
        uint256 spent = usdSpent[msg.sender];
        require(spent + usd >= minUsd * 1e18, "min");
        require(spent + usd <= maxUsd * 1e18, "max");

        tokens = usd * totalSupplyTokens / (fdvUsd * 1e18);
        uint256 remaining = _cap(ph) - (ph == 1 ? p1Sold : p2Sold);
        require(remaining != 0 && tokens != 0, "sold out");
        uint256 weiUsed = msg.value;
        if (tokens >= remaining) {
            tokens = remaining;
            // pay only for what was received, rounding up so the price is never undercut
            uint256 usdUsed = _ceilDiv(tokens * fdvUsd * 1e18, totalSupplyTokens);
            weiUsed = _ceilDiv(usdUsed * 1e8, ethUsdE8);
            if (weiUsed > msg.value) weiUsed = msg.value;
            usd = usdUsed;
            if (ph == 1) p1SoldOutAt = uint64(block.timestamp);
            else p2SoldOutAt = uint64(block.timestamp);
            emit PhaseSoldOut(ph, uint64(block.timestamp));
        }

        if (ph == 1) p1Sold += tokens;
        else p2Sold += tokens;
        usdSpent[msg.sender] = spent + usd;
        owed[msg.sender] += tokens;
        paidWei[msg.sender] += weiUsed;
        totalOwed += tokens;
        totalRaisedWei += weiUsed;
        emit Bought(msg.sender, ph, weiUsed, usd, tokens);

        _send(treasury, weiUsed);
        if (msg.value > weiUsed) _send(msg.sender, msg.value - weiUsed);
    }

    // ================================================================ TGE
    /// After the sale, once this contract holds at least what buyers are owed.
    function openClaims(address token_) external onlyOperator {
        require(phase() == 3, "sale live");
        require(!claimsOpen, "open");
        require(IERC20(token_).balanceOf(address(this)) >= totalOwed, "fund first");
        token = token_;
        claimsOpen = true;
        emit ClaimsOpened(token_, totalOwed);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        require(claimsOpen, "not yet");
        amount = owed[msg.sender];
        require(amount != 0, "nothing");
        owed[msg.sender] = 0;
        totalOwed -= amount;
        _pay(token, msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// Sends anything above what buyers are still owed to the treasury - e.g. an over-funding,
    /// or tokens sent by mistake. Never touches the owed amount of the sale token.
    function sweep(address t) external onlyOperator {
        uint256 bal = IERC20(t).balanceOf(address(this));
        uint256 keep = t == token ? totalOwed : 0;
        require(bal > keep, "nothing");
        _pay(t, treasury, bal - keep);
        emit Swept(t, bal - keep);
    }

    // ================================================================ views
    /// 0 = not started, 1 = Squeeks holders, 2 = public, 3 = ended.
    function phase() public view returns (uint8) {
        if (start == 0 || block.timestamp < start) return 0;
        uint256 p1End = p1SoldOutAt != 0 ? p1SoldOutAt : start + p1Duration;
        if (block.timestamp < p1End) return 1;
        uint256 p2End = p2SoldOutAt != 0 ? p2SoldOutAt : p1End + p2Duration;
        if (block.timestamp < p2End) return 2;
        return 3;
    }

    /**
     * Everything the site needs in one call. phaseStart/phaseEnd are the SCHEDULED window of the
     * current phase (the time-based progress bar), not when it sold out.
     */
    function status()
        external
        view
        returns (
            uint8 ph,
            uint64 phaseStart,
            uint64 phaseEnd,
            uint256 capNow,
            uint256 soldNow,
            uint256 raisedWei,
            uint256 rate,
            uint256 tokensPerUsdE18
        )
    {
        ph = phase();
        uint256 p1End = p1SoldOutAt != 0 ? p1SoldOutAt : start + p1Duration;
        if (ph <= 1) {
            phaseStart = start;
            phaseEnd = uint64(start + p1Duration);
        } else {
            phaseStart = uint64(p1End);
            phaseEnd = uint64(p1End + p2Duration);
        }
        capNow = ph <= 1 ? p1Cap : _cap(2);
        soldNow = ph <= 1 ? p1Sold : p2Sold;
        raisedWei = totalRaisedWei;
        rate = ethUsdE8;
        tokensPerUsdE18 = fdvUsd == 0 ? 0 : totalSupplyTokens / fdvUsd;
    }

    function totalSold() external view returns (uint256) {
        return p1Sold + p2Sold;
    }

    // ================================================================ internals
    /// Phase 2 inherits whatever phase 1 did not sell.
    function _cap(uint8 ph) internal view returns (uint256) {
        return ph == 1 ? p1Cap : p2Cap + (p1Cap - p1Sold);
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return root != bytes32(0) && h == root;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth");
    }

    function _pay(address t, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }
}
