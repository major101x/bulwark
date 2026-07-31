// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuardianLog
/// @notice Append-only public record of every decision GasGuard makes.
/// @dev    Deliberately storage-free: the entire record lives in event logs, so
///         an attestation costs only the base transaction plus log data. That
///         matters because these run on Ethereum mainnet under KeeperHub's gas
///         sponsorship, and they require no capital of their own — only gas.
///
///         Holds are recorded as well as rescues. A keeper that only logs its
///         successes is not an audit trail, and the interesting judgment calls
///         are the ones where the agent declined to spend gas.
contract GuardianLog {
    enum Action {
        Hold,
        Repay,
        AddCollateral,
        SwapThenRepay
    }

    /// @param watchedWallet    position the decision concerned
    /// @param healthFactorE18  health factor, 18 decimals (1.04 => 1.04e18)
    /// @param action           what the agent decided to do
    /// @param expectedLossUsdE8 expected loss from inaction, 8 decimals
    /// @param rescueCostUsdE8  cost of the cheapest feasible remedy, 8 decimals
    /// @param gasPriceGwei     base fee observed at decision time
    /// @param remediationTxHash the resulting execution, or zero for a hold
    event Decision(
        address indexed agent,
        address indexed watchedWallet,
        Action indexed action,
        uint256 healthFactorE18,
        uint256 expectedLossUsdE8,
        uint256 rescueCostUsdE8,
        uint256 gasPriceGwei,
        bytes32 remediationTxHash,
        uint256 timestamp
    );

    /// @notice Record one decision.
    /// @dev Permissionless by design. Anyone may attest, and `agent` is indexed
    ///      on msg.sender, so readers filter by the agent they trust rather
    ///      than relying on an access-control list we would have to administer.
    function attest(
        address watchedWallet,
        Action action,
        uint256 healthFactorE18,
        uint256 expectedLossUsdE8,
        uint256 rescueCostUsdE8,
        uint256 gasPriceGwei,
        bytes32 remediationTxHash
    ) external {
        emit Decision(
            msg.sender,
            watchedWallet,
            action,
            healthFactorE18,
            expectedLossUsdE8,
            rescueCostUsdE8,
            gasPriceGwei,
            remediationTxHash,
            block.timestamp
        );
    }
}
