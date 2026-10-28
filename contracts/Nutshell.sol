// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Interfaces.sol";

/**
 * Nutshell - the hub. Protocol-owned Uniswap v4 liquidity in any pool the operator allowlists,
 * with every collected fee split the moment it lands (defaults from the tokenomics doc):
 *
 *   >=50% TREASURY  stays in the contract as free capital, redeployable into positions
 *   <=35% REWARDS   ETH for Squeeks owners, paid per epoch against a Merkle root ("rewardsBps")
 *    15%  BUYBACK   NUTS is burned on the spot; any other token is swapped to NUTS ("buybackBps")
 *
 * ============================ WHAT IS AND IS NOT MONEY HERE ============================
 * The contract's balance of any token is three things at once, and only one of them is the
 * owner's to move:
 *
 *     balance  =  free capital (principal + the 50%)  +  rewardsBal  +  buybackBal  (+ epochReserved for ETH)
 *
 * Every function that spends - opening a position, a swap, a withdrawal - re-checks
 * `balance >= rewardsBal + buybackBal (+ epochReserved)` AFTERWARDS, so it can only ever have
 * spent free capital. And fees reach the buckets ONLY through `collectFees`, which does a
 * zero-liquidity decrease: the amount it measures cannot include principal.
 *
 * The split is CONFIG ("rewardsBps", "buybackBps"), settable by owner or operator, but the
 * contract enforces the doc's bounds: rewards <= 35% and rewards + buyback <= 50%, so the
 * treasury always keeps at least half. A change only affects fees collected after it.
 *
 * Config follows nftlaunchpad2: one mapping(bytes32 => uint256) keyed by ASCII names, pushed
 * from server/config.ts by `npm run config:push`. No timelock, no access contract: 2-step
 * ownership, and the owner is meant to become a Safe before this holds real value.
 */
contract Nutshell {
    // ================================================================ constants
    uint256 public constant BPS = 10_000;
    /// Hard bounds on the configurable split. Treasury = the remainder, so it is always >= 50%
    /// and rounding dust lands there.
    uint256 public constant MAX_REWARDS_BPS = 3_500;
    uint256 public constant MAX_TAKE_BPS = 5_000;

    uint256 public constant MAX_CLAIM_DELAY = 30 days;
    uint256 public constant MIN_EPOCH_TTL = 1 days;

    address internal constant ETH = address(0);

    // Uniswap v4-periphery Actions
    uint8 internal constant A_INCREASE = 0x00;
    uint8 internal constant A_DECREASE = 0x01;
    uint8 internal constant A_MINT = 0x02;
    uint8 internal constant A_BURN = 0x03;
    uint8 internal constant A_SETTLE_PAIR = 0x0d;
    uint8 internal constant A_TAKE_PAIR = 0x11;
    uint8 internal constant A_SWEEP = 0x14;

    // ================================================================ config keys
    bytes32 internal constant K_OPERATOR = "operator";
    bytes32 internal constant K_NUTS = "nuts";
    bytes32 internal constant K_SQUEEK_NFT = "squeekNft";
    bytes32 internal constant K_POSM = "positionManager";
    bytes32 internal constant K_PERMIT2 = "permit2";
    bytes32 internal constant K_ADAPTER = "swapAdapter";
    bytes32 internal constant K_CLAIM_DELAY = "claimDelay";
    bytes32 internal constant K_EPOCH_TTL = "epochTtl";
    bytes32 internal constant K_PAUSED = "paused";
    bytes32 internal constant K_REWARDS_BPS = "rewardsBps";
    bytes32 internal constant K_BUYBACK_BPS = "buybackBps";
    /// Max share of a source balance one swap may spend, in bps. 0 = no cap.
    bytes32 internal constant K_MAX_SWAP_BPS = "maxSwapBps";

    // ================================================================ state
    mapping(bytes32 => uint256) public cfg;
    address public owner;
    address public pendingOwner;

    /// keccak256(abi.encode(PoolKey)) - the v4 PoolId.
    mapping(bytes32 => bool) public poolAllowed;

    mapping(address => uint256) public rewardsBal;
    mapping(address => uint256) public buybackBal;
    /// Rewards ETH promised to posted epochs and not yet claimed or released.
    uint256 public epochReserved;

    // lifetime totals, for the dashboard
    mapping(address => uint256) public feesCollected;
    mapping(address => uint256) public treasuryRetained;
    uint256 public nutsBurned;
    uint256 public rewardsPaid;

    struct Position {
        PoolKey key;
        bool live;
    }

    mapping(uint256 => Position) internal _positions;
    uint256[] public positionIds;

    struct Epoch {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint64 snapshotBlock;
        uint64 claimableAt;
        uint64 expiresAt;
        bool closed;
    }

    Epoch[] internal _epochs;
    /// epochId => squeekId => claimed
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    mapping(address => bool) internal _permit2Ready;
    uint256 private _lock = 1;

    // ================================================================ events
    event OwnerChanged(address indexed from, address indexed to);
    event CfgSet(bytes32 indexed key, uint256 value);
    event PoolSet(bytes32 indexed poolId, address currency0, address currency1, uint24 fee, int24 tickSpacing, bool allowed);
    event PositionOpened(uint256 indexed tokenId, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint256 liquidity);
    event PositionIncreased(uint256 indexed tokenId, uint256 liquidity);
    event PositionDecreased(uint256 indexed tokenId, uint256 liquidity, uint256 principal0, uint256 principal1);
    event PositionClosed(uint256 indexed tokenId, uint256 principal0, uint256 principal1);
    event LPFeesCollected(uint256 indexed tokenId, uint256 fee0, uint256 fee1);
    event RevenueAllocated(address indexed token, uint256 amount, uint256 treasury, uint256 rewards, uint256 buyback);
    event BucketSwapped(uint8 indexed bucket, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event BuybackExecuted(address indexed tokenIn, uint256 amountIn, uint256 nutsOut);
    event TokensBurned(uint256 amount, uint256 totalSupplyAfter);
    event RewardEpochCreated(uint256 indexed epochId, bytes32 root, uint256 total, uint64 snapshotBlock, uint64 claimableAt, uint64 expiresAt);
    event RewardEpochClosed(uint256 indexed epochId, uint256 released, bool cancelled);
    event RewardClaimed(uint256 indexed epochId, uint256 indexed squeekId, address indexed to, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event TreasurySwapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event RewardsSwept(address indexed token, uint256 amount);

    // ================================================================ modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || msg.sender == _addr(K_OPERATOR), "operator");
        _;
    }

    modifier notPaused() {
        require(cfg[K_PAUSED] == 0, "paused");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    /// Native ETH arrives from TAKE_PAIR, from the adapter, and as plain capital deposits.
    /// Anything that arrives this way is free capital, never revenue.
    receive() external payable {}

    // ================================================================ ownership
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "pending");
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================ config
    /// The owner may set any key. The operator may set only the economic knobs (split, swap cap,
    /// epoch timing, pause) - never an address, so it can never repoint the hub.
    function setCfg(bytes32[] calldata keys, uint256[] calldata values) external onlyOperator {
        require(keys.length == values.length, "len");
        bool isOwner = msg.sender == owner;
        for (uint256 i; i < keys.length; ++i) {
            if (!isOwner) require(_operatorKey(keys[i]), "owner key");
            cfg[keys[i]] = values[i];
            emit CfgSet(keys[i], values[i]);
        }
        // Zero is "not configured yet" and must stay writable, or the first single-key push onto
        // a fresh hub reverts (nftlaunchpad2 paid for that lesson). postEpoch enforces the floor.
        require(cfg[K_CLAIM_DELAY] <= MAX_CLAIM_DELAY, "claimDelay");
        uint256 ttl = cfg[K_EPOCH_TTL];
        require(ttl == 0 || ttl >= MIN_EPOCH_TTL, "epochTtl");
        require(cfg[K_REWARDS_BPS] <= MAX_REWARDS_BPS, "rewardsBps");
        require(cfg[K_REWARDS_BPS] + cfg[K_BUYBACK_BPS] <= MAX_TAKE_BPS, "split");
        require(cfg[K_MAX_SWAP_BPS] <= BPS, "maxSwapBps");
    }

    function _operatorKey(bytes32 k) internal pure returns (bool) {
        return k == K_REWARDS_BPS || k == K_BUYBACK_BPS || k == K_MAX_SWAP_BPS || k == K_CLAIM_DELAY
            || k == K_EPOCH_TTL || k == K_PAUSED;
    }

    function getCfg(bytes32[] calldata keys) external view returns (uint256[] memory out) {
        out = new uint256[](keys.length);
        for (uint256 i; i < keys.length; ++i) out[i] = cfg[keys[i]];
    }

    /// ANY pool may be allowlisted - NUTS/stock, NUTS/ETH, stock/stable, SQK/ETH - hooked or not.
    /// !! A hook runs code inside our collects and swaps and can take part of the fee. Vet each
    ///    hook before allowlisting its pool; the contract does not.
    function setPools(PoolKey[] calldata keys, bool[] calldata allowed) external onlyOperator {
        require(keys.length == allowed.length, "len");
        for (uint256 i; i < keys.length; ++i) {
            PoolKey calldata k = keys[i];
            require(k.currency0 < k.currency1, "order");
            bytes32 id = poolId(k);
            poolAllowed[id] = allowed[i];
            emit PoolSet(id, k.currency0, k.currency1, k.fee, k.tickSpacing, allowed[i]);
        }
    }

    // ================================================================ positions
    /**
     * Opens a full position from FREE capital. `liquidity` and the max amounts are computed off
     * chain (scripts read the pool price from StateView); the hub only refuses to spend a bucket.
     * For a native-ETH pool, up to amount0Max of ETH is sent and the unused part swept back.
     */
    function openPosition(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint256 liquidity,
        uint128 amount0Max,
        uint128 amount1Max
    ) external onlyOperator notPaused nonReentrant returns (uint256 tokenId) {
        bytes32 id = poolId(key);
        require(poolAllowed[id], "pool");
        tokenId = _posm().nextTokenId();

        bool native = key.currency0 == ETH;
        bytes[] memory p = new bytes[](native ? 3 : 2);
        p[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, address(this), bytes(""));
        p[1] = abi.encode(key.currency0, key.currency1);
        if (native) p[2] = abi.encode(ETH, address(this));
        bytes memory actions =
            native ? abi.encodePacked(A_MINT, A_SETTLE_PAIR, A_SWEEP) : abi.encodePacked(A_MINT, A_SETTLE_PAIR);
        _modify(key, actions, p, amount0Max);

        _positions[tokenId] = Position(key, true);
        positionIds.push(tokenId);
        emit PositionOpened(tokenId, id, tickLower, tickUpper, liquidity);
    }

    /// Collects first, so the fees accrued so far are split rather than silently folded into
    /// the new liquidity.
    function increasePosition(uint256 tokenId, uint256 liquidity, uint128 amount0Max, uint128 amount1Max)
        external
        onlyOperator
        notPaused
        nonReentrant
    {
        PoolKey memory key = _live(tokenId).key;
        _collect(tokenId, key);

        bool native = key.currency0 == ETH;
        bytes[] memory p = new bytes[](native ? 3 : 2);
        p[0] = abi.encode(tokenId, liquidity, amount0Max, amount1Max, bytes(""));
        p[1] = abi.encode(key.currency0, key.currency1);
        if (native) p[2] = abi.encode(ETH, address(this));
        bytes memory actions = native
            ? abi.encodePacked(A_INCREASE, A_SETTLE_PAIR, A_SWEEP)
            : abi.encodePacked(A_INCREASE, A_SETTLE_PAIR);
        _modify(key, actions, p, amount0Max);
        emit PositionIncreased(tokenId, liquidity);
    }

    /// Collects first, then removes liquidity. What the removal returns is PRINCIPAL - it goes
    /// back to free capital and is never split. Works while paused.
    function decreasePosition(uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min)
        external
        onlyOperator
        nonReentrant
    {
        PoolKey memory key = _live(tokenId).key;
        _collect(tokenId, key);
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(tokenId, liquidity, amount0Min, amount1Min, bytes(""));
        p[1] = abi.encode(key.currency0, key.currency1, address(this));
        (uint256 got0, uint256 got1) = _modifyTake(key, abi.encodePacked(A_DECREASE, A_TAKE_PAIR), p);
        emit PositionDecreased(tokenId, liquidity, got0, got1);
    }

    /// Collects, removes everything and burns the position NFT. Works while paused.
    function closePosition(uint256 tokenId, uint128 amount0Min, uint128 amount1Min)
        external
        onlyOperator
        nonReentrant
    {
        Position storage pos = _live(tokenId);
        PoolKey memory key = pos.key;
        _collect(tokenId, key);
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(tokenId, amount0Min, amount1Min, bytes(""));
        p[1] = abi.encode(key.currency0, key.currency1, address(this));
        (uint256 got0, uint256 got1) = _modifyTake(key, abi.encodePacked(A_BURN, A_TAKE_PAIR), p);
        pos.live = false;
        emit PositionClosed(tokenId, got0, got1);
    }

    /// PERMISSIONLESS. Fees can only ever land in the split, so anyone may trigger it.
    function collectFees(uint256[] calldata tokenIds) external nonReentrant {
        for (uint256 i; i < tokenIds.length; ++i) {
            _collect(tokenIds[i], _live(tokenIds[i]).key);
        }
    }

    // ================================================================ buckets
    /**
     * Converts part of a bucket through one allowlisted pool. Input comes out of the bucket and
     * output goes back into the SAME bucket - except NUTS bought by the buyback bucket, which is
     * burned in the same transaction. Rewards in NUTS or another token reach ETH this way
     * (two calls for a two-hop route), and buyback ETH becomes burned NUTS.
     *
     * minOut must be non-zero; the operator computes it from a quote read before the call.
     */
    function swapBucket(uint8 bucket, PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        onlyOperator
        notPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        require(bucket <= 1, "bucket");
        require(poolAllowed[poolId(key)], "pool");
        require(minOut != 0, "minOut");
        mapping(address => uint256) storage bal = bucket == 0 ? rewardsBal : buybackBal;
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;
        require(amountIn != 0 && amountIn <= bal[tokenIn], "insufficient");
        _requireSwapCap(amountIn, bal[tokenIn]);

        address adapter = _addr(K_ADAPTER);
        uint256 inBefore = _bal(tokenIn);
        uint256 outBefore = _bal(tokenOut);
        if (tokenIn == ETH) {
            ISwapAdapter(adapter).swap{value: amountIn}(key, zeroForOne, amountIn, minOut);
        } else {
            _pay(tokenIn, adapter, amountIn);
            ISwapAdapter(adapter).swap(key, zeroForOne, amountIn, minOut);
        }
        // Measured, not trusted from the adapter's return value.
        amountOut = _bal(tokenOut) - outBefore;
        uint256 spent = inBefore - _bal(tokenIn);
        require(amountOut >= minOut, "slippage");
        bal[tokenIn] -= spent;

        if (bucket == 1 && tokenOut == _addr(K_NUTS)) {
            emit BuybackExecuted(tokenIn, spent, amountOut);
            _burnNuts(amountOut);
        } else {
            bal[tokenOut] += amountOut;
        }
        emit BucketSwapped(bucket, tokenIn, tokenOut, spent, amountOut);
        _requireCovered(tokenIn);
    }

    /**
     * Swaps FREE capital through one allowlisted pool - rebalancing, accumulating SQK, moving into
     * a new market. The covered check afterwards proves no bucket was touched. Output stays free
     * capital.
     */
    function swapTreasury(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        onlyOperator
        notPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        require(poolAllowed[poolId(key)], "pool");
        require(minOut != 0 && amountIn != 0, "amount");
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;
        uint256 free = _bal(tokenIn) - _owed(tokenIn);
        require(amountIn <= free, "free");
        _requireSwapCap(amountIn, free);

        uint256 inBefore = _bal(tokenIn);
        uint256 outBefore = _bal(tokenOut);
        address adapter = _addr(K_ADAPTER);
        if (tokenIn == ETH) {
            ISwapAdapter(adapter).swap{value: amountIn}(key, zeroForOne, amountIn, minOut);
        } else {
            _pay(tokenIn, adapter, amountIn);
            ISwapAdapter(adapter).swap(key, zeroForOne, amountIn, minOut);
        }
        amountOut = _bal(tokenOut) - outBefore;
        require(amountOut >= minOut, "slippage");
        _requireCovered(tokenIn);
        emit TreasurySwapped(tokenIn, tokenOut, inBefore - _bal(tokenIn), amountOut);
    }

    /// Manual escape hatch: move part of the rewards bucket into the treasury (free capital).
    /// Expired epochs still roll back into the rewards bucket; this is for when we decide otherwise.
    function sweepRewards(address token, uint256 amount) external onlyOperator {
        require(amount != 0 && amount <= rewardsBal[token], "rewards");
        rewardsBal[token] -= amount;
        treasuryRetained[token] += amount;
        emit RewardsSwept(token, amount);
    }

    // ================================================================ rewards
    /**
     * Reserves `total` rewards ETH under a Merkle root. Leaves are
     * keccak256(bytes.concat(keccak256(abi.encode(epochId, squeekId, amount)))) - the
     * OpenZeppelin double-hash, so a leaf can never be passed off as an inner node.
     * The amounts are weighted by Squeek power at `snapshotBlock`; the data set behind the root
     * is published so anyone can rebuild it.
     */
    function postEpoch(bytes32 root, uint128 total, uint64 snapshotBlock)
        external
        onlyOperator
        notPaused
        returns (uint256 epochId)
    {
        require(root != bytes32(0) && total != 0, "empty");
        require(cfg[K_EPOCH_TTL] >= MIN_EPOCH_TTL, "epochTtl");
        require(total <= rewardsBal[ETH], "rewards");
        rewardsBal[ETH] -= total;
        epochReserved += total;

        uint64 claimableAt = uint64(block.timestamp + cfg[K_CLAIM_DELAY]);
        uint64 expiresAt = uint64(claimableAt + cfg[K_EPOCH_TTL]);
        epochId = _epochs.length;
        _epochs.push(Epoch(root, total, 0, snapshotBlock, claimableAt, expiresAt, false));
        emit RewardEpochCreated(epochId, root, total, snapshotBlock, claimableAt, expiresAt);
    }

    /// The review window's escape hatch: a root can be withdrawn until it becomes claimable.
    function cancelEpoch(uint256 epochId) external onlyOperator {
        Epoch storage e = _epochs[epochId];
        require(!e.closed && block.timestamp < e.claimableAt, "final");
        _closeEpoch(epochId, e, true);
    }

    /// PERMISSIONLESS once expired. Unclaimed ETH goes back to the REWARDS bucket.
    function closeEpoch(uint256 epochId) external {
        Epoch storage e = _epochs[epochId];
        require(!e.closed && block.timestamp >= e.expiresAt, "live");
        _closeEpoch(epochId, e, false);
    }

    /**
     * Pays each Squeek's amount to whoever owns it NOW. Anyone may call it for anyone - the ETH
     * can only go to the owner. NEVER paused. A burned (merged-away) Squeek reverts in ownerOf;
     * leave it out and its share rolls forward at closeEpoch.
     */
    function claim(
        uint256 epochId,
        uint256[] calldata squeekIds,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external nonReentrant returns (uint256 paid) {
        require(squeekIds.length == amounts.length && squeekIds.length == proofs.length, "len");
        Epoch storage e = _epochs[epochId];
        require(!e.closed && block.timestamp >= e.claimableAt && block.timestamp < e.expiresAt, "window");
        IERC721Owner nft = IERC721Owner(_addr(K_SQUEEK_NFT));
        for (uint256 i; i < squeekIds.length; ++i) {
            paid += _claimOne(epochId, e, nft, squeekIds[i], amounts[i], proofs[i]);
        }
        epochReserved -= paid;
        rewardsPaid += paid;
    }

    function _claimOne(
        uint256 epochId,
        Epoch storage e,
        IERC721Owner nft,
        uint256 id,
        uint256 amount,
        bytes32[] calldata proof
    ) internal returns (uint256) {
        require(!claimed[epochId][id], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, id, amount))));
        require(_verify(proof, e.root, leaf), "proof");
        claimed[epochId][id] = true;

        uint256 total = uint256(e.claimed) + amount;
        require(total <= e.total, "overclaim");
        e.claimed = uint128(total);

        address to = nft.ownerOf(id);
        _pay(ETH, to, amount);
        emit RewardClaimed(epochId, id, to, amount);
        return amount;
    }

    // ================================================================ treasury
    /// Owner moves FREE capital only. The covered check makes buckets and reserved epochs
    /// untouchable, whatever the amount asked for.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        _pay(token, to, amount);
        _requireCovered(token);
        emit Withdrawn(token, to, amount);
    }

    // ================================================================ views
    function poolId(PoolKey calldata key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function position(uint256 tokenId) external view returns (PoolKey memory key, bool live) {
        Position storage p = _positions[tokenId];
        return (p.key, p.live);
    }

    function positionCount() external view returns (uint256) {
        return positionIds.length;
    }

    function epoch(uint256 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    function epochCount() external view returns (uint256) {
        return _epochs.length;
    }

    /// Free capital: what openPosition and withdraw may spend.
    function freeBalance(address token) external view returns (uint256) {
        uint256 b = _bal(token);
        uint256 owed = _owed(token);
        return b > owed ? b - owed : 0;
    }

    // ================================================================ internals
    /// Zero-liquidity decrease: the delta it produces is fees and nothing else.
    function _collect(uint256 tokenId, PoolKey memory key) internal {
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        p[1] = abi.encode(key.currency0, key.currency1, address(this));
        (uint256 f0, uint256 f1) = _modifyTake(key, abi.encodePacked(A_DECREASE, A_TAKE_PAIR), p);
        _split(key.currency0, f0);
        _split(key.currency1, f1);
        emit LPFeesCollected(tokenId, f0, f1);
    }

    function _split(address token, uint256 amount) internal {
        if (amount == 0) return;
        uint256 rewards = amount * cfg[K_REWARDS_BPS] / BPS;
        uint256 buyback = amount * cfg[K_BUYBACK_BPS] / BPS;
        uint256 treasury = amount - rewards - buyback;

        feesCollected[token] += amount;
        treasuryRetained[token] += treasury;
        rewardsBal[token] += rewards;
        if (token == _addr(K_NUTS)) _burnNuts(buyback);
        else buybackBal[token] += buyback;
        emit RevenueAllocated(token, amount, treasury, rewards, buyback);
    }

    function _burnNuts(uint256 amount) internal {
        if (amount == 0) return;
        address nuts = _addr(K_NUTS);
        IBurnable(nuts).burn(amount);
        nutsBurned += amount;
        emit TokensBurned(amount, IERC20(nuts).totalSupply());
    }

    /// Spends into the PositionManager, then proves only free capital was spent.
    function _modify(PoolKey memory key, bytes memory actions, bytes[] memory params, uint256 ethMax) internal {
        uint256 value;
        if (key.currency0 == ETH) value = ethMax;
        else _readyPermit2(key.currency0);
        _readyPermit2(key.currency1);
        _posm().modifyLiquidities{value: value}(abi.encode(actions, params), block.timestamp);
        _requireCovered(key.currency0);
        _requireCovered(key.currency1);
    }

    /// Runs a take-only action list and returns what arrived, measured by balance.
    function _modifyTake(PoolKey memory key, bytes memory actions, bytes[] memory params)
        internal
        returns (uint256 got0, uint256 got1)
    {
        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);
        _posm().modifyLiquidities(abi.encode(actions, params), block.timestamp);
        got0 = _bal(key.currency0) - b0;
        got1 = _bal(key.currency1) - b1;
    }

    function _closeEpoch(uint256 epochId, Epoch storage e, bool cancelled) internal {
        e.closed = true;
        uint256 left = uint256(e.total) - e.claimed;
        epochReserved -= left;
        rewardsBal[ETH] += left;
        emit RewardEpochClosed(epochId, left, cancelled);
    }

    function _live(uint256 tokenId) internal view returns (Position storage p) {
        p = _positions[tokenId];
        require(p.live, "position");
    }

    function _owed(address token) internal view returns (uint256 owed) {
        owed = rewardsBal[token] + buybackBal[token];
        if (token == ETH) owed += epochReserved;
    }

    function _requireSwapCap(uint256 amountIn, uint256 source) internal view {
        uint256 capBps = cfg[K_MAX_SWAP_BPS];
        if (capBps != 0) require(amountIn <= source * capBps / BPS, "swap cap");
    }

    function _requireCovered(address token) internal view {
        require(_bal(token) >= _owed(token), "covered");
    }

    function _readyPermit2(address token) internal {
        if (_permit2Ready[token]) return;
        address permit2 = _addr(K_PERMIT2);
        (bool ok, bytes memory r) =
            token.call(abi.encodeCall(IERC20.approve, (permit2, type(uint256).max)));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "approve");
        IPermit2(permit2).approve(token, address(_posm()), type(uint160).max, type(uint48).max);
        _permit2Ready[token] = true;
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == ETH) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "eth");
        } else {
            (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
        }
    }

    function _bal(address token) internal view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _posm() internal view returns (IPositionManager) {
        return IPositionManager(_addr(K_POSM));
    }

    function _addr(bytes32 key) internal view returns (address) {
        return address(uint160(cfg[key]));
    }

    /// PositionManager mints with a plain _mint, but accept a safe transfer too.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
