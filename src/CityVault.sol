// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {VaultBaseV2} from "./flap/VaultBaseV2.sol";
import {
    ApproveAction,
    FieldDescriptor,
    VaultMethodSchema,
    VaultUISchema
} from "./flap/IVaultSchemasV1.sol";

/// @title CityVault
/// @notice Immutable implementation of the Site 56 city capture and revenue system.
/// @dev Internally reviewed for the Site 56 mainnet release; no independent audit was
///      commissioned. The contract has no administrator or upgrade hook. Its economic
///      parameters and ordinary asset routes are immutable. Flap tax revenue arrives
///      as native BNB. Flap's chain-specific Guardian retains only the mandatory
///      emergency full-balance recovery functions required by Vault Rule 009.
contract CityVault is VaultBaseV2, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint8 public constant CITY_COUNT = 56;
    uint8 public constant MAX_LEVEL = 3;
    uint8 public constant CAPTURES_PER_UPGRADE = 5;

    uint256 public constant TOKEN_UNIT = 1e18;
    uint256 public constant LEVEL_1_BASE_PRICE = 560_000 * TOKEN_UNIT;
    uint256 public constant LEVEL_2_BASE_PRICE = 1_120_000 * TOKEN_UNIT;
    uint256 public constant LEVEL_3_BASE_PRICE = 1_680_000 * TOKEN_UNIT;
    /// @notice Stable Lv.3 reference-price ceiling reached after four
    ///         compounding steps from the Lv.3 base price.
    /// @dev A capture at this anchor always costs 6,237,722.4 tokens. Keeping
    ///      the reference at this value avoids both unbounded growth and the
    ///      former end-of-cycle price cliff.
    uint256 public constant LEVEL_3_TERMINAL_ANCHOR = 4_798_248 * TOKEN_UNIT;

    /// @dev floor(type(uint256).max * 10_000 / 13_000), the largest
    ///      reference price whose 130% payment still fits in uint256.
    uint256 private constant MAX_CAPTURE_REFERENCE_PRICE =
        0xc4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4ec4eb;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant CAPTURE_PAYMENT_BPS = 13_000;
    uint256 public constant PREVIOUS_OWNER_BPS = 12_000;
    /// @notice Tax revenue route while the upgrade-compensation pool remains open.
    uint256 public constant DIVIDEND_BPS = 7_000;

    uint256 public constant ACC_PRECISION = 1e27;

    /// @notice Official Flap irrecoverable black-hole destination.
    /// @dev Sending tokens here removes them from practical circulation but
    ///      does not guarantee that the token's `totalSupply()` decreases.
    address public constant BLACK_HOLE = 0x00576E4Fb32296Cd973A0d413D0379609400DEad;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct City {
        address owner;
        uint64 lastCaptureAt;
        uint8 level;
        uint8 weight;
        uint8 capturesInCycle;
        uint256 anchorPrice;
        /// @dev Scaled debt (`weight * accDividendPerWeight`) prevents a new
        ///      owner or newly added weight from claiming historical revenue.
        uint256 rewardDebtScaled;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event CityClaimed(
        uint8 indexed cityId,
        address indexed owner,
        uint256 amount,
        address indexed treasury
    );

    event CityCaptured(
        uint8 indexed cityId,
        address indexed previousOwner,
        address indexed newOwner,
        uint256 referencePrice,
        uint256 paidAmount,
        uint256 previousOwnerAmount,
        uint256 burnAmount,
        uint8 captureNumber
    );

    event CityUpgraded(
        uint8 indexed cityId,
        address indexed owner,
        uint8 oldLevel,
        uint8 newLevel,
        uint8 oldWeight,
        uint8 newWeight,
        uint256 nextAnchorPrice,
        uint256 compensationCredited
    );

    event LevelThreeCycleCompleted(
        uint8 indexed cityId,
        address indexed owner,
        uint256 terminalAnchorPrice
    );

    event RevenueReceived(address indexed sender, uint256 amount, uint256 undispatchedTotal);

    event RevenueDispatched(
        uint256 grossAmount,
        uint256 dividendAmount,
        uint256 compensationAmount,
        uint256 accDividendPerWeight
    );

    event VacancyReserved(uint256 amount, uint256 cumulativeAmount);
    event VacancyReserveReleased(
        uint256 amount,
        uint256 totalWeight,
        uint256 accDividendPerWeight
    );
    event DividendSettled(uint8 indexed cityId, address indexed beneficiary, uint256 amount);

    event CompensationCredited(
        uint8 indexed cityId,
        address indexed beneficiary,
        uint256 poolBefore,
        uint16 remainingSlotsBefore,
        uint256 nativeAmount
    );

    event CompensationPoolClosed(
        uint256 recycledToDividends,
        uint256 finalTotalWeight,
        uint256 accDividendPerWeight
    );

    event NativeRevenueClaimed(
        address indexed beneficiary,
        uint256 dividendAmount,
        uint256 compensationAmount,
        uint256 totalAmount
    );

    event EmergencyWithdrawNative(address indexed to, uint256 amount);
    event EmergencyWithdrawToken(address indexed token, address indexed to, uint256 amount);

    modifier onlyGuardian() {
        require(msg.sender == _getGuardian(), "Only Flap Guardian");
        _;
    }

    // -------------------------------------------------------------------------
    // Immutable configuration
    // -------------------------------------------------------------------------

    IERC20 public immutable taxToken;
    address public immutable creator;
    address public immutable treasury;
    uint256 public immutable dispatchThreshold;
    /// @notice Compatibility getter retained for existing Flap/UI integrations.
    /// @dev Captures have no time delay, so this value is permanently zero.
    uint64 public immutable captureCooldown;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    City[CITY_COUNT] private _cities;

    uint8 public occupiedCityCount;
    uint16 public totalWeight;
    uint16 public vacantWeight;
    uint16 public remainingUpgradeSlots;

    uint256 public accDividendPerWeight;
    uint256 public undispatchedRevenue;
    uint256 public compensationAvailable;
    uint256 public vacancyReserve;
    bool public compensationPoolClosed;

    /// @dev Carries sub-wei vacancy allocations between dispatches.
    uint256 private _vacancyRemainderScaled;

    mapping(address account => uint256 amount) public claimableDividend;
    mapping(address account => uint256 amount) public claimableCompensation;
    // -------------------------------------------------------------------------
    // Construction and revenue ingress
    // -------------------------------------------------------------------------

    /// @notice Creates one immutable native-BNB CityVault instance.
    /// @param taxToken_ The Flap tax token served by this vault.
    /// @param creator_ The original Flap launch creator; informational only.
    /// @param treasury_ Immutable destination of all first-claim payments.
    /// @param dispatchThreshold_ Minimum undispatched BNB required to dispatch.
    /// @param legacyCaptureDelay_ Compatibility-only constructor field. It
    ///        must be zero and `captureCooldown()` is permanently zero.
    constructor(
        address taxToken_,
        address creator_,
        address treasury_,
        uint256 dispatchThreshold_,
        uint64 legacyCaptureDelay_
    ) {
        require(
            taxToken_ != address(0) && creator_ != address(0) && treasury_ != address(0),
            "Zero address"
        );
        require(dispatchThreshold_ != 0, "Invalid dispatch threshold");
        require(legacyCaptureDelay_ == 0, "Capture delay must be zero");

        taxToken = IERC20(taxToken_);
        creator = creator_;
        treasury = treasury_;
        dispatchThreshold = dispatchThreshold_;
        // Preserve the legacy delay getter/constructor field while making the
        // no-delay rule unambiguous even for direct deployments.
        captureCooldown = 0;

        totalWeight = CITY_COUNT;
        vacantWeight = CITY_COUNT;
        remainingUpgradeSlots = uint16(CITY_COUNT) * (MAX_LEVEL - 1);

        for (uint8 cityId = 0; cityId < CITY_COUNT; ++cityId) {
            City storage city = _cities[cityId];
            city.level = 1;
            city.weight = 1;
            city.anchorPrice = LEVEL_1_BASE_PRICE;
        }
    }

    /// @notice Records native BNB and automatically dispatches at the threshold.
    /// @dev The automatic path is O(1), makes no external calls and is safe for
    ///      Flap's tax-revenue hot path.
    receive() external payable {
        if (msg.value == 0) return;
        undispatchedRevenue += msg.value;
        emit RevenueReceived(msg.sender, msg.value, undispatchedRevenue);

        if (undispatchedRevenue >= dispatchThreshold) {
            _checkpointRevenue();
        }
    }

    // -------------------------------------------------------------------------
    // City actions
    // -------------------------------------------------------------------------

    /// @notice Claims an unoccupied city for the fixed level-one base price.
    function claimCity(uint256 cityId, uint256 payment) external nonReentrant {
        _checkCityId(cityId);
        require(payment == LEVEL_1_BASE_PRICE, "Invalid claim payment");

        uint8 cityIndex = uint8(cityId);

        City storage city = _cities[cityIndex];
        require(city.owner == address(0), "City already claimed");

        // Attribute every pre-claim wei using the old vacancy set. This is a
        // forced checkpoint even when the public dispatch threshold is unmet.
        _checkpointRevenue();

        // Effects before all ERC-20 interactions (CEI).
        city.owner = msg.sender;
        city.lastCaptureAt = uint64(block.timestamp);
        city.rewardDebtScaled = accDividendPerWeight;

        occupiedCityCount += 1;
        vacantWeight -= 1;

        emit CityClaimed(cityIndex, msg.sender, payment, treasury);

        // Once the city is complete, recycle every whole wei previously
        // reserved for vacant weight across all current city weights. The new
        // owner's debt was deliberately set before this index increase, so the
        // 56th city receives only its ordinary weighted share. This remains
        // O(1), performs no external call and clears sub-wei vacancy carry that
        // can no longer accrue once vacantWeight is zero.
        if (occupiedCityCount == CITY_COUNT) {
            _releaseVacancyReserve();
        }

        _pullTaxTokens(msg.sender, payment);
        taxToken.safeTransfer(treasury, payment);
    }

    /// @notice Captures an occupied city by paying 130% of its anchor price.
    /// @dev The old owner receives an immediate token transfer worth 120% of
    ///      the reference price; the remainder is sent to Flap's black hole.
    function captureCity(
        uint256 cityId,
        uint256 maxPayment,
        uint256 deadline,
        uint256 minCompOut
    ) external nonReentrant {
        _checkCityId(cityId);
        _checkDeadline(deadline);

        uint8 cityIndex = uint8(cityId);

        City storage city = _cities[cityIndex];
        address previousOwner = city.owner;
        require(previousOwner != address(0), "City not claimed");
        require(previousOwner != msg.sender, "Current owner cannot capture");

        // Attribute every pre-capture wei under the old owner and old weight,
        // including a tail below the public dispatch threshold.
        _checkpointRevenue();

        (
            uint256 referencePrice,
            uint256 payment,
            uint256 previousOwnerAmount,
            uint256 burnAmount,
            bool willUpgrade,
            ,
            uint256 compensation
        ) = _quoteCapture(city, compensationAvailable);

        require(payment <= maxPayment, "Payment exceeds maximum");
        require(compensation >= minCompOut, "Compensation below minimum");

        // Complete every accounting and ownership effect before interacting
        // with the ERC-20 token (CEI). A later token failure reverts all effects.
        _settleCity(cityIndex, city);
        uint8 captureNumber = city.capturesInCycle + 1;
        city.owner = msg.sender;
        city.lastCaptureAt = uint64(block.timestamp);
        city.capturesInCycle = captureNumber;
        city.anchorPrice = city.level >= MAX_LEVEL
            ? Math.min(payment, LEVEL_3_TERMINAL_ANCHOR)
            : payment;

        emit CityCaptured(
            cityIndex,
            previousOwner,
            msg.sender,
            referencePrice,
            payment,
            previousOwnerAmount,
            burnAmount,
            captureNumber
        );

        if (willUpgrade) {
            _upgradeCity(cityIndex, city, compensation);
        } else {
            // Ownership changed, so discard the former owner's sub-wei reward
            // remainder and start the new owner's accrual at the current index.
            city.rewardDebtScaled = uint256(city.weight) * accDividendPerWeight;

            // Level three has no further upgrade or compensation. Its counter
            // remains a five-capture display cycle, while the reference price
            // stays at the stable terminal ceiling instead of falling back to
            // the base or growing without bound.
            if (city.level >= MAX_LEVEL && captureNumber >= CAPTURES_PER_UPGRADE) {
                city.capturesInCycle = 0;
                emit LevelThreeCycleCompleted(
                    cityIndex,
                    msg.sender,
                    city.anchorPrice
                );
            }
        }

        _pullTaxTokens(msg.sender, payment);
        taxToken.safeTransfer(previousOwner, previousOwnerAmount);
        taxToken.safeTransfer(BLACK_HOLE, burnAmount);
    }

    /// @notice Settles one city's accrued dividend into its current owner's credit.
    /// @dev Permissionless: callers can help any owner update accounting.
    function settleCity(uint256 cityId) external returns (uint256 amount) {
        _checkCityId(cityId);
        uint8 cityIndex = uint8(cityId);
        City storage city = _cities[cityIndex];
        require(city.owner != address(0), "City not claimed");
        return _settleCity(cityIndex, city);
    }

    // -------------------------------------------------------------------------
    // Revenue distribution and pull claims
    // -------------------------------------------------------------------------

    /// @notice Dispatches all accumulated native revenue once the threshold is met.
    /// @dev O(1), permissionless and performs no external calls.
    function dispatchRevenue() external {
        uint256 grossAmount = undispatchedRevenue;
        require(grossAmount >= dispatchThreshold, "Revenue below threshold");

        _checkpointRevenue();
    }

    /// @notice Pulls all settled native dividend and compensation credits.
    function claimRevenue() external nonReentrant returns (uint256 amount) {
        uint256 dividendAmount = claimableDividend[msg.sender];
        uint256 compensationAmount = claimableCompensation[msg.sender];
        amount = dividendAmount + compensationAmount;
        require(amount != 0, "Nothing to claim");

        claimableDividend[msg.sender] = 0;
        claimableCompensation[msg.sender] = 0;

        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success, "Native transfer failed");

        emit NativeRevenueClaimed(msg.sender, dividendAmount, compensationAmount, amount);
    }

    /// @notice Flap Guardian black-swan recovery required by Vault Rule 009.
    function emergencyWithdrawNative(address to) external onlyGuardian nonReentrant {
        require(to != address(0), "Zero address");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            require(ok, "Native transfer failed");
            emit EmergencyWithdrawNative(to, bal);
        }
    }

    /// @notice Flap Guardian stuck-token recovery required by Vault Rule 009.
    function emergencyWithdrawToken(address token, address to) external onlyGuardian nonReentrant {
        require(token != address(0) && to != address(0), "Zero address");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).safeTransfer(to, bal);
            emit EmergencyWithdrawToken(token, to, bal);
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCity(uint256 cityId)
        external
        view
        returns (
            address owner,
            uint256 lastCaptureAt,
            uint256 level,
            uint256 weight,
            uint256 capturesInCycle,
            uint256 anchorPrice,
            uint256 rewardDebtScaled
        )
    {
        _checkCityId(cityId);
        City storage city = _cities[uint8(cityId)];
        return (
            city.owner,
            city.lastCaptureAt,
            city.level,
            city.weight,
            city.capturesInCycle,
            city.anchorPrice,
            city.rewardDebtScaled
        );
    }

    /// @notice Quotes the exact next capture and its currently available compensation.
    function quoteCapture(uint256 cityId)
        public
        view
        returns (
            uint256 referencePrice,
            uint256 payment,
            uint256 previousOwnerAmount,
            uint256 burnAmount,
            bool willUpgrade,
            uint256 nextLevel,
            uint256 compensation
        )
    {
        _checkCityId(cityId);
        uint8 cityIndex = uint8(cityId);
        City storage city = _cities[cityIndex];
        require(city.owner != address(0), "City not claimed");

        uint256 projectedCompensationAvailable = _projectedCompensationAvailable();

        return _quoteCapture(city, projectedCompensationAvailable);
    }

    function _quoteCapture(
        City storage city,
        uint256 availableCompensation
    )
        private
        view
        returns (
            uint256 referencePrice,
            uint256 payment,
            uint256 previousOwnerAmount,
            uint256 burnAmount,
            bool willUpgrade,
            uint8 nextLevel,
            uint256 compensation
        )
    {

        referencePrice = city.anchorPrice;
        // A clear protocol error is preferable to an opaque mulDiv overflow at
        // the theoretical end of uint256 price space.
        require(referencePrice <= MAX_CAPTURE_REFERENCE_PRICE, "Capture price overflow");

        payment = Math.mulDiv(referencePrice, CAPTURE_PAYMENT_BPS, BPS_DENOMINATOR);
        previousOwnerAmount = Math.mulDiv(referencePrice, PREVIOUS_OWNER_BPS, BPS_DENOMINATOR);
        burnAmount = payment - previousOwnerAmount;

        willUpgrade = city.level < MAX_LEVEL
            && city.capturesInCycle + 1 == CAPTURES_PER_UPGRADE;
        nextLevel = willUpgrade ? city.level + 1 : city.level;
        compensation = willUpgrade
            ? _quoteUpgradeCompensation(availableCompensation)
            : 0;
    }

    function pendingCityDividend(uint256 cityId) public view returns (uint256 amount) {
        _checkCityId(cityId);
        City storage city = _cities[uint8(cityId)];
        if (city.owner == address(0)) return 0;

        uint256 accruedScaled = uint256(city.weight) * accDividendPerWeight;
        return (accruedScaled - city.rewardDebtScaled) / ACC_PRECISION;
    }

    function accountState(address account)
        external
        view
        returns (uint256 dividendCredit, uint256 compensationCredit)
    {
        return (claimableDividend[account], claimableCompensation[account]);
    }

    function levelBasePrice(uint256 level) public pure returns (uint256) {
        if (level == 1) return LEVEL_1_BASE_PRICE;
        if (level == 2) return LEVEL_2_BASE_PRICE;
        if (level == 3) return LEVEL_3_BASE_PRICE;
        require(false, "Invalid level");
        return 0;
    }

    function previewUpgradeCompensation(uint256 currentLevel)
        external
        view
        returns (uint256 projectedPool, uint256 remainingSlots, uint256 compensation)
    {
        require(currentLevel != 0 && currentLevel < MAX_LEVEL, "Invalid level");
        projectedPool = _projectedCompensationAvailable();
        remainingSlots = remainingUpgradeSlots;
        if (remainingSlots != 0) compensation = projectedPool / remainingSlots;
    }

    function description() public view override returns (string memory) {
        return string.concat(
            "Site 56 CityVault: ",
            uint256(occupiedCityCount).toString(),
            "/56 cities occupied; total dividend weight ",
            uint256(totalWeight).toString(),
            "; undispatched native revenue ",
            undispatchedRevenue.toString(),
            " wei. Immutable accounting; internally reviewed without an independent audit."
        );
    }

    /// @notice Machine-readable Flap UI description for the core interaction surface.
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "Site56CityVault";
        schema.description =
            "Immutable 56-city capture, weighted-dividend and upgrade-compensation system; internally reviewed without an independent audit.";
        schema.methods = new VaultMethodSchema[](11);

        schema.methods[0] = _method("getCity", "Read one city's owner, level, weight and accounting state.", false);
        schema.methods[0].inputs = _oneField("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[0].outputs = new FieldDescriptor[](7);
        schema.methods[0].outputs[0] = FieldDescriptor("owner", "address", "Current city owner", 0);
        schema.methods[0].outputs[1] = FieldDescriptor("lastCaptureAt", "time", "Last ownership change", 0);
        schema.methods[0].outputs[2] = FieldDescriptor("level", "uint256", "City level", 0);
        schema.methods[0].outputs[3] = FieldDescriptor("weight", "uint256", "Dividend weight", 0);
        schema.methods[0].outputs[4] =
            FieldDescriptor("capturesInCycle", "uint256", "Captures in current cycle", 0);
        schema.methods[0].outputs[5] =
            FieldDescriptor("anchorPrice", "uint256", "Current token reference price", 18);
        schema.methods[0].outputs[6] =
            FieldDescriptor("rewardDebtScaled", "uint256", "Internal scaled reward debt", 0);

        schema.methods[1] = _method("quoteCapture", "Preview the exact next capture payment, burn and compensation.", false);
        schema.methods[1].inputs = _oneField("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[1].outputs = new FieldDescriptor[](7);
        schema.methods[1].outputs[0] =
            FieldDescriptor("referencePrice", "uint256", "Current anchor price", 18);
        schema.methods[1].outputs[1] =
            FieldDescriptor("payment", "uint256", "Required tax-token payment", 18);
        schema.methods[1].outputs[2] =
            FieldDescriptor("previousOwnerAmount", "uint256", "Immediate payment to current owner", 18);
        schema.methods[1].outputs[3] =
            FieldDescriptor("burnAmount", "uint256", "Amount sent to black hole", 18);
        schema.methods[1].outputs[4] =
            FieldDescriptor("willUpgrade", "bool", "Whether this capture upgrades the city", 0);
        schema.methods[1].outputs[5] =
            FieldDescriptor("nextLevel", "uint256", "Level after this capture", 0);
        schema.methods[1].outputs[6] =
            FieldDescriptor("compensation", "uint256", "Currently quoted BNB compensation", 18);

        schema.methods[2] = _method("pendingCityDividend", "Read one city's unsettled native-BNB dividend.", false);
        schema.methods[2].inputs = _oneField("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[2].outputs =
            _oneField("amount", "uint256", "Unsettled native-BNB dividend", 18);

        schema.methods[3] = _method("accountState", "Read an account's settled dividend and compensation credits.", false);
        schema.methods[3].inputs = _oneField("account", "address", "Account to inspect", 0);
        schema.methods[3].outputs = new FieldDescriptor[](2);
        schema.methods[3].outputs[0] = FieldDescriptor("dividendCredit", "uint256", "Settled native-BNB dividend", 18);
        schema.methods[3].outputs[1] = FieldDescriptor("compensationCredit", "uint256", "Settled native-BNB compensation", 18);

        schema.methods[4] = _method("levelBasePrice", "Read the fixed tax-token base price for city level 1, 2 or 3.", false);
        schema.methods[4].inputs = _oneField("level", "uint256", "City level from 1 to 3", 0);
        schema.methods[4].outputs = _oneField("price", "uint256", "Level base price", 18);

        schema.methods[5] = _method("previewUpgradeCompensation", "Preview the projected native-BNB compensation for the next upgrade.", false);
        schema.methods[5].inputs = _oneField("currentLevel", "uint256", "Current city level 1 or 2", 0);
        schema.methods[5].outputs = new FieldDescriptor[](3);
        schema.methods[5].outputs[0] = FieldDescriptor("projectedPool", "uint256", "Projected compensation pool", 18);
        schema.methods[5].outputs[1] = FieldDescriptor("remainingSlots", "uint256", "Remaining network-wide upgrade slots", 0);
        schema.methods[5].outputs[2] = FieldDescriptor("compensation", "uint256", "Projected compensation", 18);

        schema.methods[6] = _method("claimCity", "Claim an empty city for 560,000 tax tokens.", true);
        schema.methods[6].inputs = new FieldDescriptor[](2);
        schema.methods[6].inputs[0] = FieldDescriptor("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[6].inputs[1] =
            FieldDescriptor("payment", "uint256", "Must equal exactly 560,000 tokens", 18);
        schema.methods[6].approvals = _taxTokenApproval("payment");

        schema.methods[7] = _method("captureCity", "Capture a city with payment, deadline and compensation slippage limits.", true);
        schema.methods[7].inputs = new FieldDescriptor[](4);
        schema.methods[7].inputs[0] = FieldDescriptor("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[7].inputs[1] =
            FieldDescriptor("maxPayment", "uint256", "Maximum token payment", 18);
        schema.methods[7].inputs[2] = FieldDescriptor("deadline", "time", "Transaction deadline", 0);
        schema.methods[7].inputs[3] =
            FieldDescriptor("minCompOut", "uint256", "Minimum BNB compensation", 18);
        schema.methods[7].approvals = _taxTokenApproval("maxPayment");

        schema.methods[8] = _method("dispatchRevenue", "Permissionlessly dispatch threshold-ready BNB; receive also dispatches automatically.", true);

        schema.methods[9] = _method("settleCity", "Credit one city's pending dividend to its current owner.", true);
        schema.methods[9].inputs = _oneField("cityId", "uint256", "City ID from 0 to 55", 0);
        schema.methods[9].outputs = _oneField("amount", "uint256", "Dividend credited by execution", 18);

        schema.methods[10] = _method("claimRevenue", "Pull settled native dividends and upgrade compensation.", true);
        schema.methods[10].outputs = _oneField("amount", "uint256", "Native BNB claimed by execution", 18);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _upgradeCity(uint8 cityId, City storage city, uint256 compensation) private {
        uint256 poolBefore = compensationAvailable;
        uint16 remainingSlotsBefore = remainingUpgradeSlots;
        uint8 oldLevel = city.level;
        uint8 newLevel = oldLevel + 1;
        uint8 oldWeight = city.weight;
        uint8 newWeight = oldWeight + 1;

        city.level = newLevel;
        city.weight = newWeight;
        city.capturesInCycle = 0;
        city.anchorPrice = levelBasePrice(newLevel);
        city.rewardDebtScaled = uint256(newWeight) * accDividendPerWeight;

        totalWeight += 1;
        remainingUpgradeSlots -= 1;

        if (compensation != 0) {
            compensationAvailable -= compensation;
            claimableCompensation[city.owner] += compensation;
            emit CompensationCredited(
                cityId,
                city.owner,
                poolBefore,
                remainingSlotsBefore,
                compensation
            );
        }

        emit CityUpgraded(
            cityId,
            city.owner,
            oldLevel,
            newLevel,
            oldWeight,
            newWeight,
            city.anchorPrice,
            compensation
        );

        // The final upgrade first receives its ordinary capped compensation.
        // Only the remaining pool is then converted into a dividend using the
        // fully upgraded final weight set. The closure is permanent.
        if (remainingUpgradeSlots == 0) {
            uint256 recycledToDividends = compensationAvailable;
            compensationAvailable = 0;
            compensationPoolClosed = true;
            _allocateDividend(recycledToDividends);

            emit CompensationPoolClosed(
                recycledToDividends,
                totalWeight,
                accDividendPerWeight
            );
        }
    }

    function _settleCity(uint8 cityId, City storage city) private returns (uint256 amount) {
        uint256 accruedScaled = uint256(city.weight) * accDividendPerWeight;
        uint256 pendingScaled = accruedScaled - city.rewardDebtScaled;
        amount = pendingScaled / ACC_PRECISION;

        // Retain sub-wei entitlement for the same owner. Capture/upgrade resets
        // debt to the exact current index before ownership changes take effect.
        city.rewardDebtScaled = accruedScaled - (pendingScaled % ACC_PRECISION);

        if (amount != 0) {
            claimableDividend[city.owner] += amount;
            emit DividendSettled(cityId, city.owner, amount);
        }
    }

    function _quoteUpgradeCompensation(uint256 availableCompensation) private view returns (uint256 amount) {
        if (
            compensationPoolClosed || remainingUpgradeSlots == 0
                || availableCompensation == 0
        ) return 0;
        return availableCompensation / remainingUpgradeSlots;
    }

    /// @dev Moves every pending native wei into its accounting buckets. This
    ///      helper is intentionally O(1) and contains no external call.
    function _checkpointRevenue() private {
        uint256 grossAmount = undispatchedRevenue;
        if (grossAmount == 0) return;

        undispatchedRevenue = 0;

        uint256 dividendAmount;
        uint256 compensationAmount = 0;
        if (compensationPoolClosed) {
            dividendAmount = grossAmount;
        } else {
            dividendAmount = Math.mulDiv(grossAmount, DIVIDEND_BPS, BPS_DENOMINATOR);
            compensationAmount = grossAmount - dividendAmount;
            compensationAvailable += compensationAmount;
        }

        _allocateDividend(dividendAmount);

        emit RevenueDispatched(
            grossAmount,
            dividendAmount,
            compensationAmount,
            accDividendPerWeight
        );
    }

    /// @dev Adds one native-dividend amount to the accumulator and vacancy
    ///      reserve. O(1), state-only and contains no external call.
    function _allocateDividend(uint256 dividendAmount) private {
        if (dividendAmount == 0) return;

        uint256 indexIncrease = Math.mulDiv(dividendAmount, ACC_PRECISION, totalWeight);
        accDividendPerWeight += indexIncrease;

        uint256 scaledVacancy = _vacancyRemainderScaled + (indexIncrease * vacantWeight);
        uint256 newlyReserved = scaledVacancy / ACC_PRECISION;
        _vacancyRemainderScaled = scaledVacancy % ACC_PRECISION;
        if (newlyReserved != 0) {
            vacancyReserve += newlyReserved;
            emit VacancyReserved(newlyReserved, vacancyReserve);
        }
    }

    /// @dev Recycles the completed city's vacancy reserve into the same
    ///      cumulative index used by ordinary dividends. The prior fractional
    ///      vacancy carry participates in the index calculation; any remainder
    ///      smaller than one scaled-weight unit becomes irreducible dust.
    function _releaseVacancyReserve() private {
        uint256 amount = vacancyReserve;
        uint256 vacancyRemainderScaled = _vacancyRemainderScaled;

        vacancyReserve = 0;
        _vacancyRemainderScaled = 0;

        if (amount != 0 || vacancyRemainderScaled != 0) {
            uint256 indexIncrease = Math.mulDiv(amount, ACC_PRECISION, totalWeight);
            uint256 scaledModulo = mulmod(amount, ACC_PRECISION, totalWeight);
            indexIncrease += (scaledModulo + vacancyRemainderScaled) / totalWeight;
            accDividendPerWeight += indexIncrease;
        }

        emit VacancyReserveReleased(amount, totalWeight, accDividendPerWeight);
    }

    /// @dev Projects only the compensation side of a mandatory checkpoint.
    ///      Once the pool closes, all pending revenue is a dividend instead.
    function _projectedCompensationAvailable() private view returns (uint256 available) {
        if (compensationPoolClosed) return 0;

        uint256 pendingRevenue = undispatchedRevenue;
        uint256 pendingDividend =
            Math.mulDiv(pendingRevenue, DIVIDEND_BPS, BPS_DENOMINATOR);
        uint256 pendingCompensation = pendingRevenue - pendingDividend;
        return compensationAvailable + pendingCompensation;
    }

    function _pullTaxTokens(address from, uint256 amount) private {
        uint256 balanceBefore = taxToken.balanceOf(address(this));
        taxToken.safeTransferFrom(from, address(this), amount);
        uint256 received = taxToken.balanceOf(address(this)) - balanceBefore;
        require(received == amount, "Tax token transfer mismatch");
    }

    function _checkCityId(uint256 cityId) private pure {
        require(cityId < CITY_COUNT, "Invalid city ID");
    }

    function _checkDeadline(uint256 deadline) private view {
        require(block.timestamp <= deadline, "Deadline expired");
    }

    function _oneField(string memory name, string memory fieldType, string memory fieldDescription, uint8 decimals)
        private
        pure
        returns (FieldDescriptor[] memory fields)
    {
        fields = new FieldDescriptor[](1);
        fields[0] = FieldDescriptor(name, fieldType, fieldDescription, decimals);
    }

    function _method(string memory name, string memory methodDescription, bool isWriteMethod)
        private
        pure
        returns (VaultMethodSchema memory method)
    {
        method.name = name;
        method.description = methodDescription;
        method.inputs = new FieldDescriptor[](0);
        method.outputs = new FieldDescriptor[](0);
        method.approvals = new ApproveAction[](0);
        method.isInputArray = false;
        method.isOutputArray = false;
        method.isWriteMethod = isWriteMethod;
    }

    function _taxTokenApproval(string memory amountFieldName)
        private
        pure
        returns (ApproveAction[] memory approvals)
    {
        approvals = new ApproveAction[](1);
        approvals[0] = ApproveAction("taxToken", amountFieldName);
    }
}
