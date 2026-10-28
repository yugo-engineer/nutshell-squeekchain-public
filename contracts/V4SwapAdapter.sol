// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "./Interfaces.sol";

/**
 * V4SwapAdapter - one exact-input swap through one Uniswap v4 pool, and nothing else.
 *
 * THE ADAPTER EXISTS SO THE HUB IS NOT A V4 TAKER. A v4 swap runs inside PoolManager.unlock,
 * which calls back into whoever unlocked, so the taker must expose an `unlockCallback` that
 * cannot carry a reentrancy guard - it IS the re-entry. That does not belong on the contract
 * holding every bucket. Same split as nftlaunchpad2's adapters.
 *
 * It holds nothing between calls: the caller sends the input (ERC-20 transfer before the call,
 * or msg.value for ETH), the output goes straight from the PoolManager to the caller, and any
 * input the pool did not consume is refunded in the same call.
 *
 * `caller` is an immutable: on deploy it is the Nutshell hub. The fork tests deploy a second
 * one with themselves as caller to play the part of a trader.
 */
contract V4SwapAdapter {
    IPoolManager public immutable poolManager;
    address public immutable caller;

    // TickMath.MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1: "no price limit" in either direction.
    // The caller's minOut is the slippage bound, not the price limit.
    uint160 internal constant MIN_LIMIT = 4295128740;
    uint160 internal constant MAX_LIMIT = 1461446703485210103287273052203988822378723970341;

    struct Job {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    constructor(address poolManager_, address caller_) {
        require(poolManager_ != address(0) && caller_ != address(0), "zero");
        poolManager = IPoolManager(poolManager_);
        caller = caller_;
    }

    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        payable
        returns (uint256 amountOut)
    {
        require(msg.sender == caller, "caller");
        require(amountIn != 0, "amountIn");
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        require(tokenIn == address(0) ? msg.value == amountIn : msg.value == 0, "value");

        bytes memory ret = poolManager.unlock(abi.encode(Job(key, zeroForOne, amountIn)));
        uint256 paid;
        (paid, amountOut) = abi.decode(ret, (uint256, uint256));
        require(amountOut >= minOut, "slippage");

        // Liquidity ran out before the whole input was used: hand the rest back.
        if (paid < amountIn) _pay(tokenIn, msg.sender, amountIn - paid);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pm");
        Job memory j = abi.decode(data, (Job));

        int256 delta = poolManager.swap(
            j.key,
            SwapParams(j.zeroForOne, -int256(j.amountIn), j.zeroForOne ? MIN_LIMIT : MAX_LIMIT),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (int128 dIn, int128 dOut) = j.zeroForOne ? (d0, d1) : (d1, d0);
        require(dIn <= 0 && dOut >= 0, "delta");

        uint256 paid = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        address tokenIn = j.zeroForOne ? j.key.currency0 : j.key.currency1;
        address tokenOut = j.zeroForOne ? j.key.currency1 : j.key.currency0;

        if (paid != 0) {
            if (tokenIn == address(0)) {
                poolManager.settle{value: paid}();
            } else {
                poolManager.sync(tokenIn);
                _pay(tokenIn, address(poolManager), paid);
                poolManager.settle();
            }
        }
        if (out != 0) poolManager.take(tokenOut, caller, out);
        return abi.encode(paid, out);
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "eth");
        } else {
            (bool ok, bytes memory r) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
        }
    }
}
