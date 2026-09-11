// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import {CityVault} from "./CityVault.sol";
import {IPortalTypes} from "./flap/IPortal.sol";
import {IVaultFactory, IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {FactoryPolicy, FieldDescriptor, VaultDataSchema} from "./flap/IVaultSchemasV1.sol";
import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";

/// @dev Isolates CityVault creation bytecode from the factory runtime so both
///      deployed contracts remain below the EIP-170 code-size limit. The
///      creating factory is immutable and is the only permitted caller.
contract CityVaultDeployer {
    address private immutable _factory;

    error OnlyFactory();

    constructor() {
        _factory = msg.sender;
    }

    function deploy(
        address taxToken,
        address creator,
        address treasury,
        uint256 dispatchThreshold,
        uint64 legacyCaptureDelay
    ) external returns (address vault) {
        if (msg.sender != _factory) revert OnlyFactory();
        vault = address(
            new CityVault(taxToken, creator, treasury, dispatchThreshold, legacyCaptureDelay)
        );
    }
}

/// @title CityVaultFactory
/// @notice Deploys immutable, native-BNB CityVault instances through Flap's
///         canonical VaultPortal.
/// @dev vaultData must be ABI-encoded as
///      (address treasury, uint256 dispatchThreshold, uint256 captureCooldown).
///      The final field is retained for Flap vaultData ABI compatibility and
///      must be zero because captures have no time delay.
///      This internally reviewed release has no owner, admin, proxy, or
///      post-deployment configuration path and has not received an independent audit.
///      dispatchThreshold remains a per-deployment input; its mainnet value must be
///      publicly committed, reviewed, and frozen before launch.
contract CityVaultFactory is VaultFactoryBaseV2 {
    uint16 public constant REQUIRED_BUY_TAX_BPS = 300;
    uint16 public constant REQUIRED_SELL_TAX_BPS = 300;
    uint16 public constant REQUIRED_VAULT_BPS = 10_000;
    uint64 public constant NO_CAPTURE_DELAY = 0;

    CityVaultDeployer public immutable vaultDeployer;

    error UnsupportedQuoteToken(address quoteToken);
    error ZeroDispatchThreshold();
    error NonzeroCaptureDelay(uint256 provided);

    event CityVaultCreated(
        address indexed vault,
        address indexed taxToken,
        address indexed creator,
        address treasury,
        uint256 dispatchThreshold,
        uint64 captureCooldown
    );

    constructor() {
        vaultDeployer = new CityVaultDeployer();
    }

    /// @inheritdoc VaultFactoryBaseV2
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "Creates an immutable native-BNB CityVault. Configure the treasury, tax dispatch threshold, "
            "and the zero-valued legacy delay field.";
        schema.fields = new FieldDescriptor[](3);
        schema.fields[0] = FieldDescriptor({
            name: "treasury",
            fieldType: "address",
            description: "Treasury that receives initial city-claim token payments.",
            decimals: 0
        });
        schema.fields[1] = FieldDescriptor({
            name: "dispatchThreshold",
            fieldType: "uint256",
            description: "BNB dispatch threshold; its mainnet value must be reviewed and frozen before launch.",
            decimals: 18
        });
        schema.fields[2] = FieldDescriptor({
            name: "captureCooldown",
            fieldType: "uint256",
            description: "Legacy compatibility field; must be 0 because captures are immediate.",
            decimals: 0
        });
        schema.isArray = false;
    }

    /// @inheritdoc VaultFactoryBaseV2
    function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory policies) {
        policies = new FactoryPolicy[](10);
        policies[0] = FactoryPolicy({
            target: "tokenVersion",
            operator: "eq",
            value: abi.encode(IPortalTypes.TokenVersion.TOKEN_TAXED_V3),
            description: "Token version must be TOKEN_TAXED_V3."
        });
        policies[1] = FactoryPolicy({
            target: "quoteToken",
            operator: "eq",
            value: abi.encode(address(0)),
            description: "Quote token must be native BNB."
        });
        policies[2] = FactoryPolicy({
            target: "buyTaxRate",
            operator: "eq",
            value: abi.encode(REQUIRED_BUY_TAX_BPS),
            description: "Buy tax must be 300 bps (3%)."
        });
        policies[3] = FactoryPolicy({
            target: "sellTaxRate",
            operator: "eq",
            value: abi.encode(REQUIRED_SELL_TAX_BPS),
            description: "Sell tax must be 300 bps (3%)."
        });
        policies[4] = FactoryPolicy({
            target: "mktBps",
            operator: "eq",
            value: abi.encode(REQUIRED_VAULT_BPS),
            description: "All collected tax must be allocated to the vault."
        });
        policies[5] = FactoryPolicy({
            target: "deflationBps",
            operator: "eq",
            value: abi.encode(uint16(0)),
            description: "Flap-level deflation allocation must be zero."
        });
        policies[6] = FactoryPolicy({
            target: "dividendBps",
            operator: "eq",
            value: abi.encode(uint16(0)),
            description: "Flap-level dividend allocation must be zero; CityVault handles revenue distribution."
        });
        policies[7] = FactoryPolicy({
            target: "lpBps",
            operator: "eq",
            value: abi.encode(uint16(0)),
            description: "Flap-level LP allocation must be zero."
        });
        policies[8] = FactoryPolicy({
            target: "minimumShareBalance",
            operator: "eq",
            value: abi.encode(uint256(0)),
            description: "Minimum share balance must be zero because CityVault maintains its own accounting."
        });
        policies[9] = FactoryPolicy({
            target: "dividendToken",
            operator: "eq",
            value: abi.encode(address(0)),
            description: "Dividend token must be native BNB; Flap-level dividends are disabled."
        });
    }

    /// @inheritdoc VaultFactoryBaseV2
    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.tokenVersion != IPortalTypes.TokenVersion.TOKEN_TAXED_V3) {
            return (false, "CityVault requires TOKEN_TAXED_V3.");
        }
        if (data.quoteToken != address(0)) {
            return (false, "CityVault supports native BNB only.");
        }
        if (data.buyTaxRate != REQUIRED_BUY_TAX_BPS) {
            return (false, "CityVault requires a 3% buy tax.");
        }
        if (data.sellTaxRate != REQUIRED_SELL_TAX_BPS) {
            return (false, "CityVault requires a 3% sell tax.");
        }
        if (data.vaultBps != REQUIRED_VAULT_BPS) {
            return (false, "CityVault requires 100% of collected tax to be allocated to the vault.");
        }
        if (data.deflationBps != 0) {
            return (false, "CityVault requires deflationBps to be zero.");
        }
        if (data.dividendBps != 0) {
            return (false, "CityVault requires dividendBps to be zero.");
        }
        if (data.lpBps != 0) {
            return (false, "CityVault requires lpBps to be zero.");
        }
        if (data.minimumShareBalance != 0) {
            return (false, "CityVault requires minimumShareBalance to be zero.");
        }
        if (data.dividendToken != address(0)) {
            return (false, "CityVault requires dividendToken to be native BNB.");
        }
        return (true, "");
    }

    /// @inheritdoc IVaultFactory
    function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        if (block.chainid != 56 && block.chainid != 97) revert UnsupportedChain(block.chainid);
        if (msg.sender != _getVaultPortal()) revert OnlyVaultPortal();
        if (quoteToken != address(0)) revert UnsupportedQuoteToken(quoteToken);
        if (taxToken == address(0) || creator == address(0)) revert ZeroAddress();

        (address treasury, uint256 dispatchThreshold, uint256 captureDelayRaw) =
            abi.decode(vaultData, (address, uint256, uint256));

        if (treasury == address(0)) revert ZeroAddress();
        if (dispatchThreshold == 0) revert ZeroDispatchThreshold();
        if (captureDelayRaw != NO_CAPTURE_DELAY) revert NonzeroCaptureDelay(captureDelayRaw);

        vault = vaultDeployer.deploy(taxToken, creator, treasury, dispatchThreshold, NO_CAPTURE_DELAY);

        emit CityVaultCreated(
            vault,
            taxToken,
            creator,
            treasury,
            dispatchThreshold,
            NO_CAPTURE_DELAY
        );
    }

    /// @inheritdoc IVaultFactory
    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool supported) {
        return quoteToken == address(0);
    }
}
