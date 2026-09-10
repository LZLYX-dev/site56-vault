// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "../lib/forge-std/src/Test.sol";
import {CityVault} from "../src/CityVault.sol";
import {CityVaultFactory} from "../src/CityVaultFactory.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
import {
    VaultDataSchema,
    VaultUISchema
} from "../src/flap/IVaultSchemasV1.sol";

contract CityVaultFoundryTest is Test {
    uint256 internal constant FIRST_CLAIM_PRICE = 560_000 ether;
    uint256 internal constant DISPATCH_THRESHOLD = 100 ether;
    address internal constant TESTNET_GUARDIAN =
        0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;
    address internal constant TESTNET_VAULT_PORTAL =
        0x027e3704fC5C16522e9393d04C60A3ac5c0d775f;

    MockERC20 internal token;
    CityVault internal vault;
    address internal treasury;
    address internal alice;
    address internal bob;
    address internal recipient;

    function setUp() public {
        vm.chainId(97);
        treasury = makeAddr("treasury");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        recipient = makeAddr("recipient");

        token = new MockERC20();
        vault = new CityVault(
            address(token),
            address(this),
            treasury,
            DISPATCH_THRESHOLD,
            0
        );

        token.mint(alice, 20_000_000 ether);
        token.mint(bob, 20_000_000 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function testInitializesAllFiftySixCities() public view {
        (
            address owner,
            ,
            uint256 level,
            uint256 weight,
            uint256 captures,
            uint256 anchorPrice,

        ) = vault.getCity(0);

        assertEq(owner, address(0));
        assertEq(level, 1);
        assertEq(weight, 1);
        assertEq(captures, 0);
        assertEq(anchorPrice, FIRST_CLAIM_PRICE);
        assertEq(vault.totalWeight(), 56);
        assertEq(vault.vacantWeight(), 56);
        assertEq(vault.remainingUpgradeSlots(), 112);
    }

    function testClaimAndFirstCaptureEconomics() public {
        vm.prank(alice);
        vault.claimCity(0, FIRST_CLAIM_PRICE);
        assertEq(token.balanceOf(treasury), FIRST_CLAIM_PRICE);

        (
            uint256 referencePrice,
            uint256 payment,
            uint256 previousOwnerAmount,
            uint256 burnAmount,
            bool willUpgrade,
            uint256 nextLevel,
            uint256 compensation
        ) = vault.quoteCapture(0);
        assertEq(referencePrice, 560_000 ether);
        assertEq(payment, 728_000 ether);
        assertEq(previousOwnerAmount, 672_000 ether);
        assertEq(burnAmount, 56_000 ether);
        assertFalse(willUpgrade);
        assertEq(nextLevel, 1);
        assertEq(compensation, 0);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        vault.captureCity(0, payment, block.timestamp + 1 hours, 0);

        assertEq(token.balanceOf(alice), aliceBefore + previousOwnerAmount);
        assertEq(token.balanceOf(bob), bobBefore - payment);
        assertEq(token.balanceOf(vault.BLACK_HOLE()), burnAmount);
    }

    function testCriticalCityWritesRejectInvalidPreconditions() public {
        vm.expectRevert(bytes("Invalid claim payment"));
        vm.prank(alice);
        vault.claimCity(0, FIRST_CLAIM_PRICE - 1);

        vm.prank(alice);
        vault.claimCity(0, FIRST_CLAIM_PRICE);

        vm.expectRevert(bytes("Current owner cannot capture"));
        vm.prank(alice);
        vault.captureCity(0, type(uint256).max, block.timestamp + 1 hours, 0);
    }

    function testFiveCapturesUpgradeExactlyOnce() public {
        vm.prank(alice);
        vault.claimCity(0, FIRST_CLAIM_PRICE);

        address[5] memory captors = [bob, alice, bob, alice, bob];
        for (uint256 i; i < captors.length; ++i) {
            (, uint256 payment,,,,,) = vault.quoteCapture(0);
            vm.prank(captors[i]);
            vault.captureCity(0, payment, block.timestamp + 1 hours, 0);
        }

        (
            address owner,
            ,
            uint256 level,
            uint256 weight,
            uint256 captures,
            uint256 anchorPrice,

        ) = vault.getCity(0);
        assertEq(owner, bob);
        assertEq(level, 2);
        assertEq(weight, 2);
        assertEq(captures, 0);
        assertEq(anchorPrice, 1_120_000 ether);
        assertEq(vault.totalWeight(), 57);
        assertEq(vault.remainingUpgradeSlots(), 111);
    }

    function testNativeRevenueDispatchesSeventyThirty() public {
        vm.deal(address(this), DISPATCH_THRESHOLD);
        (bool ok,) = address(vault).call{value: DISPATCH_THRESHOLD}("");
        assertTrue(ok);

        assertEq(vault.undispatchedRevenue(), 0);
        assertEq(vault.compensationAvailable(), 30 ether);
        assertEq(
            vault.accDividendPerWeight(),
            (70 ether * 1e27) / 56
        );
    }

    function testReceiveWorstCaseGasStaysUnderOneMillion() public {
        vm.deal(address(this), DISPATCH_THRESHOLD);
        uint256 gasBefore = gasleft();
        (bool ok,) = address(vault).call{value: DISPATCH_THRESHOLD}("");
        uint256 gasUsed = gasBefore - gasleft();

        assertTrue(ok);
        assertLe(gasUsed, 1_000_000, "receive() exceeds 1M gas limit");
    }

    function testSettledRevenueCanBeClaimedOnlyWhenNonzero() public {
        vm.prank(alice);
        vault.claimCity(0, FIRST_CLAIM_PRICE);

        vm.deal(address(this), DISPATCH_THRESHOLD);
        (bool ok,) = address(vault).call{value: DISPATCH_THRESHOLD}("");
        assertTrue(ok);
        vault.settleCity(0);

        uint256 credit = vault.claimableDividend(alice);
        uint256 beforeBalance = alice.balance;
        vm.prank(alice);
        vault.claimRevenue();
        assertEq(alice.balance, beforeBalance + credit);

        vm.expectRevert(bytes("Nothing to claim"));
        vm.prank(alice);
        vault.claimRevenue();
    }

    function testOnlyGuardianCanUseEmergencyRecovery() public {
        vm.expectRevert(bytes("Only Flap Guardian"));
        vault.emergencyWithdrawNative(recipient);

        vm.expectRevert(bytes("Only Flap Guardian"));
        vault.emergencyWithdrawToken(address(token), recipient);

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        token.mint(address(vault), 123 ether);

        vm.prank(TESTNET_GUARDIAN);
        vault.emergencyWithdrawNative(recipient);
        vm.prank(TESTNET_GUARDIAN);
        vault.emergencyWithdrawToken(address(token), recipient);

        assertEq(address(vault).balance, 0);
        assertEq(recipient.balance, 1 ether);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(recipient), 123 ether);
    }

    function testDescriptionAndVaultUiSchemaAreComplete() public view {
        assertGt(bytes(vault.description()).length, 0);
        VaultUISchema memory schema = vault.vaultUISchema();
        assertGt(bytes(schema.vaultType).length, 0);
        assertGt(bytes(schema.description).length, 0);
        assertEq(schema.methods.length, 11);

        for (uint256 i; i < schema.methods.length; ++i) {
            assertGt(bytes(schema.methods[i].name).length, 0);
            assertGt(bytes(schema.methods[i].description).length, 0);
            assertEq(schema.methods[i].isWriteMethod, i >= 6);
        }
    }

    function testFactoryPublishesRequiredPoliciesAndSchema() public {
        CityVaultFactory factory = new CityVaultFactory();
        assertEq(factory.factorySpecVersion(), "v2.2");
        assertEq(factory.tokenCreationPolicies().length, 10);
        VaultDataSchema memory schema = factory.vaultDataSchema();
        assertEq(schema.fields.length, 3);
        assertEq(schema.fields[0].fieldType, "address");
        assertEq(schema.fields[1].fieldType, "uint256");
        assertEq(schema.fields[2].fieldType, "uint256");
        assertTrue(factory.isQuoteTokenSupported(address(0)));
        assertFalse(factory.isQuoteTokenSupported(address(1)));
    }

    function testFactoryNewVaultSucceedsOnlyFromVaultPortal() public {
        CityVaultFactory factory = new CityVaultFactory();
        bytes memory vaultData = abi.encode(treasury, 0.25 ether, uint256(0));

        vm.expectRevert(bytes("Only VaultPortal"));
        factory.newVault(address(token), address(0), alice, vaultData);

        vm.prank(TESTNET_VAULT_PORTAL);
        address created = factory.newVault(
            address(token),
            address(0),
            alice,
            vaultData
        );
        assertGt(created.code.length, 0);

        CityVault createdVault = CityVault(payable(created));
        assertEq(address(createdVault.taxToken()), address(token));
        assertEq(createdVault.creator(), alice);
        assertEq(createdVault.treasury(), treasury);
        assertEq(createdVault.dispatchThreshold(), 0.25 ether);
        assertEq(createdVault.captureCooldown(), 0);
    }

    function testFuzzRejectsEveryOutOfRangeCityId(uint256 cityId) public {
        cityId = bound(cityId, 56, type(uint256).max);
        vm.expectRevert(bytes("Invalid city ID"));
        vault.getCity(cityId);
    }
}
