// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

// Every external surface Nutshell touches, written out by hand. No OpenZeppelin, no v4-core
// import: one flat solc run compiles the tree and verification gets a full match.
//
// Uniswap's Currency and BalanceDelta are user-defined value types over address and int256,
// so their ABI is identical to the plain types used here.

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// The NUTS burn that lowers totalSupply. A transfer to 0xdead is NOT this.
interface IBurnable {
    function burn(uint256 amount) external;
}

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// Uniswap v4 PoolKey. currency0 < currency1; address(0) is native ETH and always sorts first.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// Uniswap v4 IPoolManager.SwapParams. Negative amountSpecified = exact input.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    /// Returns BalanceDelta: amount0 in the high 128 bits, amount1 in the low 128.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IPositionManager {
    /// unlockData = abi.encode(bytes actions, bytes[] params)
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface ISwapAdapter {
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        payable
        returns (uint256 amountOut);
}
