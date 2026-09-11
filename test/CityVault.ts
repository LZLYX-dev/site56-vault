import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  maxUint256,
  parseEther,
  parseGwei,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
} from "viem";

const connection = await network.create();
const { viem, networkHelpers } = connection;

const token = (amount: string) => parseUnits(amount, 18);

const CITY_COUNT = 56n;
const FIRST_CLAIM_PRICE = token("560000");
const LEVEL_TWO_PRICE = token("1120000");
const LEVEL_THREE_PRICE = token("1680000");
const LEVEL_THREE_ANCHOR_CAP = token("4798248");
const NO_CAPTURE_DELAY = 0n;
const DISPATCH_THRESHOLD = parseEther("100");
const LARGE_TOKEN_BALANCE = token("250000000");

type LooseContract = any;
type LooseWallet = any;

function tupleField<T>(value: any, name: string, index: number): T {
  return (value?.[name] ?? value?.[index]) as T;
}

function cityView(raw: any) {
  return {
    owner: tupleField<string>(raw, "owner", 0),
    level: Number(tupleField<number | bigint>(raw, "level", 1)),
    weight: Number(tupleField<number | bigint>(raw, "weight", 2)),
    capturesInCycle: Number(
      tupleField<number | bigint>(raw, "capturesInCycle", 3),
    ),
    anchorPrice: BigInt(tupleField<bigint>(raw, "anchorPrice", 4)),
    lastCaptureAt: BigInt(tupleField<bigint>(raw, "lastCaptureAt", 5)),
    rewardDebt: BigInt(
      raw?.rewardDebtScaled ?? tupleField<bigint>(raw, "rewardDebt", 6),
    ),
  };
}

function captureQuote(raw: any) {
  // The preferred ABI returns referencePrice first. Named components keep this
  // helper compatible if Solidity/Viem decodes the tuple as an object.
  const hasReferencePrice =
    raw?.referencePrice !== undefined ||
    raw?.anchorPrice !== undefined ||
    (Array.isArray(raw) && raw.length >= 4);
  const offset = hasReferencePrice ? 1 : 0;

  return {
    referencePrice: BigInt(
      raw?.referencePrice ?? raw?.anchorPrice ?? raw?.[0] ?? 0n,
    ),
    requiredPayment: BigInt(
      raw?.requiredPayment ?? raw?.payment ?? raw?.[offset] ?? 0n,
    ),
    previousOwnerAmount: BigInt(
      raw?.previousOwnerAmount ??
        raw?.previousOwnerProceeds ??
        raw?.ownerProceeds ??
        raw?.[offset + 1] ??
        0n,
    ),
    burnAmount: BigInt(raw?.burnAmount ?? raw?.[offset + 2] ?? 0n),
  };
}

async function asWallet(
  contractName: string,
  address: `0x${string}`,
  wallet: LooseWallet,
): Promise<LooseContract> {
  return viem.getContractAt(contractName, address, {
    client: { wallet },
  }) as Promise<LooseContract>;
}

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const [deployer, treasury, alice, bob, carol, outsider, dave, erin] = wallets;

  const erc20 = (await viem.deployContract("MockERC20")) as LooseContract;
  const vault = (await viem.deployContract("CityVault", [
    erc20.address,
    deployer.account.address,
    treasury.account.address,
    DISPATCH_THRESHOLD,
    NO_CAPTURE_DELAY,
  ])) as LooseContract;

  for (const wallet of [alice, bob, carol, outsider, dave, erin]) {
    await erc20.write.mint([wallet.account.address, LARGE_TOKEN_BALANCE]);
    const writableToken = await asWallet("MockERC20", erc20.address, wallet);
    await writableToken.write.approve([vault.address, maxUint256]);
  }

  return {
    wallets,
    deployer,
    treasury,
    alice,
    bob,
    carol,
    outsider,
    dave,
    erin,
    erc20,
    vault,
  };
}

async function deployFinalSlotFixture() {
  const wallets = await viem.getWalletClients();
  const [deployer, treasury, alice, bob] = wallets;
  const erc20 = (await viem.deployContract("MockERC20")) as LooseContract;
  const vault = (await viem.deployContract("CityVaultHarness", [
    erc20.address,
    deployer.account.address,
    treasury.account.address,
    DISPATCH_THRESHOLD,
    NO_CAPTURE_DELAY,
  ])) as LooseContract;

  for (const wallet of [alice, bob]) {
    await erc20.write.mint([wallet.account.address, LARGE_TOKEN_BALANCE]);
    const writableToken = await asWallet("MockERC20", erc20.address, wallet);
    await writableToken.write.approve([vault.address, maxUint256]);
  }

  return { deployer, treasury, alice, bob, erc20, vault };
}

async function deployReentrantFixture() {
  const wallets = await viem.getWalletClients();
  const [deployer, treasury, alice, bob] = wallets;
  const erc20 = (await viem.deployContract("ReentrantERC20")) as LooseContract;
  const vault = (await viem.deployContract("CityVault", [
    erc20.address,
    deployer.account.address,
    treasury.account.address,
    DISPATCH_THRESHOLD,
    NO_CAPTURE_DELAY,
  ])) as LooseContract;

  for (const wallet of [alice, bob]) {
    await erc20.write.mint([wallet.account.address, LARGE_TOKEN_BALANCE]);
    const writableToken = await asWallet("ReentrantERC20", erc20.address, wallet);
    await writableToken.write.approve([vault.address, maxUint256]);
  }

  return { deployer, treasury, alice, bob, erc20, vault };
}

async function deadlineAfter(seconds = 3_600n) {
  const latest = BigInt(await networkHelpers.time.latest());
  return latest + seconds;
}

async function claimCity(
  vault: LooseContract,
  wallet: LooseWallet,
  cityId: number,
) {
  const writableVault = await asWallet("CityVault", vault.address, wallet);
  await writableVault.write.claimCity([cityId, FIRST_CLAIM_PRICE]);
}

async function captureCity(
  vault: LooseContract,
  wallet: LooseWallet,
  cityId: number,
  minCompOut = 0n,
  maxPayment?: bigint,
) {
  const quote = captureQuote(await vault.read.quoteCapture([cityId]));
  const writableVault = await asWallet("CityVault", vault.address, wallet);
  await writableVault.write.captureCity([
    cityId,
    maxPayment ?? quote.requiredPayment,
    await deadlineAfter(),
    minCompOut,
  ]);
  return quote;
}

async function sendNativeRevenue(
  vault: LooseContract,
  sender: LooseWallet,
  amount: bigint,
) {
  await sender.sendTransaction({ to: vault.address, value: amount });
}

async function performCaptureCycle(
  vault: LooseContract,
  firstCaptor: LooseWallet,
  secondCaptor: LooseWallet,
  cityId = 0,
) {
  const captors = [
    firstCaptor,
    secondCaptor,
    firstCaptor,
    secondCaptor,
    firstCaptor,
  ];

  for (const captor of captors) {
    await captureCity(vault, captor, cityId);
  }
}

describe("CityVault", { concurrency: false }, function () {
  it("rejects zero dispatch thresholds and any nonzero legacy capture delay", async function () {
    const { deployer, treasury, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);

    await viem.assertions.revertWithCustomError(
      viem.deployContract("CityVault", [
        erc20.address,
        deployer.account.address,
        treasury.account.address,
        0n,
        NO_CAPTURE_DELAY,
      ]),
      vault,
      "InvalidDispatchThreshold",
    );
    await viem.assertions.revertWithCustomError(
      viem.deployContract("CityVault", [
        erc20.address,
        deployer.account.address,
        treasury.account.address,
        DISPATCH_THRESHOLD,
        1n,
      ]),
      vault,
      "NonzeroCaptureDelay",
    );
    assert.equal(await vault.read.captureCooldown(), NO_CAPTURE_DELAY);
  });

  it("rejects quoting, settling, or capturing an unclaimed city", async function () {
    const { bob, vault } = await networkHelpers.loadFixture(deployFixture);
    const bobVault = await asWallet("CityVault", vault.address, bob);

    await viem.assertions.revertWithCustomError(
      vault.read.quoteCapture([0]),
      vault,
      "CityNotClaimed",
    );
    await viem.assertions.revertWithCustomError(
      bobVault.write.settleCity([0]),
      vault,
      "CityNotClaimed",
    );
    await viem.assertions.revertWithCustomError(
      bobVault.write.captureCity([
        0,
        maxUint256,
        await deadlineAfter(),
        0n,
      ]),
      vault,
      "CityNotClaimed",
    );
  });

  it("rejects a capture attempt by the current city owner", async function () {
    const { alice, vault } = await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);
    const aliceVault = await asWallet("CityVault", vault.address, alice);

    await viem.assertions.revertWithCustomError(
      aliceVault.write.captureCity([
        0,
        maxUint256,
        await deadlineAfter(),
        0n,
      ]),
      vault,
      "CurrentOwnerCannotCapture",
    );
  });

  it("rejects a native-revenue claim when the caller has no settled credit", async function () {
    const { bob, vault } = await networkHelpers.loadFixture(deployFixture);
    const bobVault = await asWallet("CityVault", vault.address, bob);

    await viem.assertions.revertWithCustomError(
      bobVault.write.claimRevenue(),
      vault,
      "NothingToClaim",
    );
  });

  it("initializes 56 vacant weight-one cities and transfers an exact first claim to treasury", async function () {
    const { treasury, alice, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);

    const initial = cityView(await vault.read.getCity([0]));
    assert.equal(initial.owner, zeroAddress);
    assert.equal(initial.level, 1);
    assert.equal(initial.weight, 1);
    assert.equal(initial.capturesInCycle, 0);
    assert.equal(initial.anchorPrice, FIRST_CLAIM_PRICE);
    assert.equal(BigInt(await vault.read.totalWeight()), CITY_COUNT);

    const supplyBefore = await erc20.read.totalSupply();
    const treasuryBefore = await erc20.read.balanceOf([
      treasury.account.address,
    ]);

    await claimCity(vault, alice, 0);

    const claimed = cityView(await vault.read.getCity([0]));
    assert.equal(claimed.owner.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(claimed.level, 1);
    assert.equal(claimed.weight, 1);
    assert.equal(claimed.capturesInCycle, 0);
    assert.equal(claimed.anchorPrice, FIRST_CLAIM_PRICE);
    assert.equal(
      await erc20.read.balanceOf([treasury.account.address]),
      treasuryBefore + FIRST_CLAIM_PRICE,
    );
    assert.equal(await erc20.read.totalSupply(), supplyBefore);

    const aliceVault = await asWallet("CityVault", vault.address, alice);
    await viem.assertions.revertWithCustomError(
      aliceVault.write.claimCity([0, FIRST_CLAIM_PRICE]),
      vault,
      "CityAlreadyClaimed",
    );
    await viem.assertions.revertWithCustomError(
      aliceVault.write.claimCity([56, FIRST_CLAIM_PRICE]),
      vault,
      "InvalidCityId",
    );
  });

  it("quotes and accounts the first 728k capture as 672k owner payment plus a 56k black-hole transfer", async function () {
    const { alice, bob, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    const quote = captureQuote(await vault.read.quoteCapture([0]));
    assert.equal(quote.referencePrice, FIRST_CLAIM_PRICE);
    assert.equal(quote.requiredPayment, token("728000"));
    assert.equal(quote.previousOwnerAmount, token("672000"));
    assert.equal(quote.burnAmount, token("56000"));

    const bobBefore = await erc20.read.balanceOf([bob.account.address]);
    const aliceBefore = await erc20.read.balanceOf([alice.account.address]);
    const blackHole = await vault.read.BLACK_HOLE();
    const blackHoleBefore = await erc20.read.balanceOf([blackHole]);
    await captureCity(vault, bob, 0);

    const captured = cityView(await vault.read.getCity([0]));
    assert.equal(captured.owner.toLowerCase(), bob.account.address.toLowerCase());
    assert.equal(captured.capturesInCycle, 1);
    assert.equal(captured.anchorPrice, token("728000"));
    assert.equal(
      await erc20.read.balanceOf([bob.account.address]),
      bobBefore - token("728000"),
    );
    assert.equal(
      await erc20.read.balanceOf([alice.account.address]),
      aliceBefore + token("672000"),
    );
    assert.equal(
      await erc20.read.balanceOf([blackHole]),
      blackHoleBefore + token("56000"),
    );
  });

  it("requires the exact 560k claim payment argument and an exact usable allowance", async function () {
    const { wallets, treasury, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);
    const claimant = wallets[8];
    await erc20.write.mint([claimant.account.address, FIRST_CLAIM_PRICE]);

    const claimantVault = await asWallet("CityVault", vault.address, claimant);
    const claimantToken = await asWallet("MockERC20", erc20.address, claimant);

    await assert.rejects(
      claimantVault.write.claimCity([0, FIRST_CLAIM_PRICE - 1n]),
    );
    await assert.rejects(
      claimantVault.write.claimCity([0, FIRST_CLAIM_PRICE + 1n]),
    );
    await assert.rejects(
      claimantVault.write.claimCity([0, FIRST_CLAIM_PRICE]),
    );

    await claimantToken.write.approve([vault.address, FIRST_CLAIM_PRICE - 1n]);
    await assert.rejects(
      claimantVault.write.claimCity([0, FIRST_CLAIM_PRICE]),
    );

    await claimantToken.write.approve([vault.address, FIRST_CLAIM_PRICE]);
    const treasuryBefore = await erc20.read.balanceOf([
      treasury.account.address,
    ]);
    await claimantVault.write.claimCity([0, FIRST_CLAIM_PRICE]);

    assert.equal(
      await erc20.read.balanceOf([treasury.account.address]),
      treasuryBefore + FIRST_CLAIM_PRICE,
    );
    assert.equal(await erc20.read.balanceOf([claimant.account.address]), 0n);
  });

  it("reproduces the complete Lv.1 five-capture table and upgrades the fifth buyer", async function () {
    const { alice, bob, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    const rows = [
      ["560000", "728000", "672000", "56000"],
      ["728000", "946400", "873600", "72800"],
      ["946400", "1230320", "1135680", "94640"],
      ["1230320", "1599416", "1476384", "123032"],
      ["1599416", "2079240.8", "1919299.2", "159941.6"],
    ] as const;
    const captors = [bob, alice, bob, alice, bob];
    let previousOwner = alice.account.address;
    let cumulativeBurn = 0n;
    const blackHole = await vault.read.BLACK_HOLE();
    const blackHoleBefore = await erc20.read.balanceOf([blackHole]);

    for (let index = 0; index < rows.length; index += 1) {
      const [reference, paid, ownerAmount, burned] = rows[index];

      const quote = captureQuote(await vault.read.quoteCapture([0]));
      assert.equal(quote.referencePrice, token(reference));
      assert.equal(quote.requiredPayment, token(paid));
      assert.equal(quote.previousOwnerAmount, token(ownerAmount));
      assert.equal(quote.burnAmount, token(burned));

      const previousOwnerBefore = await erc20.read.balanceOf([previousOwner]);
      await captureCity(vault, captors[index], 0);
      cumulativeBurn += token(burned);

      assert.equal(
        await erc20.read.balanceOf([previousOwner]),
        previousOwnerBefore + token(ownerAmount),
      );
      assert.equal(
        await erc20.read.balanceOf([blackHole]),
        blackHoleBefore + cumulativeBurn,
      );
      previousOwner = captors[index].account.address;
    }

    assert.equal(cumulativeBurn, token("506413.6"));
    const upgraded = cityView(await vault.read.getCity([0]));
    assert.equal(upgraded.owner.toLowerCase(), bob.account.address.toLowerCase());
    assert.equal(upgraded.level, 2);
    assert.equal(upgraded.weight, 2);
    assert.equal(upgraded.capturesInCycle, 0);
    assert.equal(upgraded.anchorPrice, LEVEL_TWO_PRICE);
    assert.equal(BigInt(await vault.read.totalWeight()), 57n);
  });

  it("enforces deadline and max-payment protection", async function () {
    const { alice, bob, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    const bobVault = await asWallet("CityVault", vault.address, bob);
    const quote = captureQuote(await vault.read.quoteCapture([0]));
    const latest = BigInt(await networkHelpers.time.latest());

    await viem.assertions.revertWithCustomError(
      bobVault.write.captureCity([
        0,
        quote.requiredPayment - 1n,
        latest + 3_600n,
        0n,
      ]),
      vault,
      "PaymentExceedsMaximum",
    );
    await viem.assertions.revertWithCustomError(
      bobVault.write.captureCity([
        0,
        quote.requiredPayment,
        latest - 1n,
        0n,
      ]),
      vault,
      "DeadlineExpired",
    );

  });

  it("executes five captures in one block and upgrades immediately", async function () {
    const { alice, bob, carol, outsider, dave, erin, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    const testClient = await viem.getTestClient();
    const publicClient = await viem.getPublicClient();
    const deadline = await deadlineAfter();
    const captors = [bob, carol, outsider, dave, erin];
    const hashes: `0x${string}`[] = [];

    await testClient.setAutomine(false);
    try {
      for (let index = 0; index < captors.length; index += 1) {
        const data = encodeFunctionData({
          abi: vault.abi,
          functionName: "captureCity",
          args: [0, maxUint256, deadline, 0n],
        });
        hashes.push(await captors[index].sendTransaction({
          to: vault.address,
          data,
          gas: 1_500_000n,
          // Strictly descending prices make the intended ownership sequence
          // deterministic inside the single mined block.
          gasPrice: parseGwei(String(10 - index)),
        }));
      }
      await testClient.mine({ blocks: 1 });
    } finally {
      await testClient.setAutomine(true);
    }

    const receipts = await Promise.all(
      hashes.map((hash) => publicClient.getTransactionReceipt({ hash })),
    );
    assert(receipts.every((receipt) => receipt.status === "success"));
    assert(receipts.every(
      (receipt) => receipt.blockNumber === receipts[0].blockNumber,
    ));

    const upgraded = cityView(await vault.read.getCity([0]));
    const block = await publicClient.getBlock({
      blockNumber: receipts[0].blockNumber,
    });
    assert.equal(upgraded.owner.toLowerCase(), erin.account.address.toLowerCase());
    assert.equal(upgraded.level, 2);
    assert.equal(upgraded.weight, 2);
    assert.equal(upgraded.capturesInCycle, 0);
    assert.equal(upgraded.anchorPrice, LEVEL_TWO_PRICE);
    assert.equal(upgraded.lastCaptureAt, block.timestamp);
    assert.equal(BigInt(await vault.read.totalWeight()), 57n);
  });

  it("rejects fee-on-transfer tokens without leaving partial city state", async function () {
    const wallets = await viem.getWalletClients();
    const [deployer, treasury, alice] = wallets;
    const erc20 = (await viem.deployContract(
      "FeeOnTransferERC20",
    )) as LooseContract;
    const vault = (await viem.deployContract("CityVault", [
      erc20.address,
      deployer.account.address,
      treasury.account.address,
      DISPATCH_THRESHOLD,
      NO_CAPTURE_DELAY,
    ])) as LooseContract;
    const aliceToken = await asWallet(
      "FeeOnTransferERC20",
      erc20.address,
      alice,
    );
    const aliceVault = await asWallet("CityVault", vault.address, alice);

    await erc20.write.mint([alice.account.address, FIRST_CLAIM_PRICE]);
    await aliceToken.write.approve([vault.address, FIRST_CLAIM_PRICE]);
    const aliceBefore = await erc20.read.balanceOf([alice.account.address]);
    const treasuryBefore = await erc20.read.balanceOf([
      treasury.account.address,
    ]);

    await viem.assertions.revertWithCustomError(
      aliceVault.write.claimCity([0, FIRST_CLAIM_PRICE]),
      vault,
      "TaxTokenTransferMismatch",
    );

    const city = cityView(await vault.read.getCity([0]));
    assert.equal(city.owner, zeroAddress);
    assert.equal(await vault.read.occupiedCityCount(), 0);
    assert.equal(await erc20.read.balanceOf([alice.account.address]), aliceBefore);
    assert.equal(
      await erc20.read.balanceOf([treasury.account.address]),
      treasuryBefore,
    );
    assert.equal(await erc20.read.balanceOf([vault.address]), 0n);
  });

  it("reports CapturePriceOverflow for a deliberately corrupted test-state anchor", async function () {
    const { alice, vault } =
      await networkHelpers.loadFixture(deployFinalSlotFixture);
    await claimCity(vault, alice, 0);

    // City 0 is the first element of the fixed _cities array. Its packed
    // metadata occupies slot 0 and anchorPrice occupies slot 1. Verify the
    // injected value through getCity before exercising the production quote.
    const overflowAnchor = (maxUint256 / 13n) * 10n + 1n;
    await networkHelpers.setStorageAt(vault.address, 1n, overflowAnchor);
    assert.equal(
      cityView(await vault.read.getCity([0])).anchorPrice,
      overflowAnchor,
    );

    await viem.assertions.revertWithCustomError(
      vault.read.quoteCapture([0]),
      vault,
      "CapturePriceOverflow",
    );
  });

  it("keeps revenue below threshold pending, then auto-dispatches exactly 70/30 on receipt", async function () {
    const { deployer, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);

    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD - 1n,
    });
    assert.equal(
      await vault.read.undispatchedRevenue(),
      DISPATCH_THRESHOLD - 1n,
    );

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await viem.assertions.revertWithCustomError(
      outsiderVault.write.dispatchRevenue(),
      vault,
      "RevenueBelowThreshold",
    );

    await deployer.sendTransaction({ to: vault.address, value: 1n });

    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(await vault.read.compensationAvailable(), parseEther("30"));
    assert.equal(
      await vault.read.accDividendPerWeight(),
      (parseEther("70") * 10n ** 27n) / CITY_COUNT,
    );
  });

  it("checkpoints sub-threshold revenue to vacancy before a new city is claimed", async function () {
    const { deployer, alice, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);
    const gross = parseEther("10");
    const dividend = parseEther("7");
    const indexIncrease = (dividend * 10n ** 27n) / CITY_COUNT;

    await deployer.sendTransaction({ to: vault.address, value: gross });
    assert.equal(await vault.read.undispatchedRevenue(), gross);

    await claimCity(vault, alice, 0);
    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(await vault.read.compensationAvailable(), parseEther("3"));
    assert.equal(await vault.read.accDividendPerWeight(), indexIncrease);
    assert.equal(
      await vault.read.vacancyReserve(),
      (indexIncrease * CITY_COUNT) / 10n ** 27n,
    );

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await outsiderVault.write.settleCity([0]);
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      0n,
    );
  });

  it("checkpoints sub-threshold revenue to the old owner before capture changes ownership", async function () {
    const { deployer, alice, bob, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    const gross = parseEther("10");
    const dividend = parseEther("7");
    const indexIncrease = (dividend * 10n ** 27n) / CITY_COUNT;
    const oldOwnerShare = indexIncrease / 10n ** 27n;
    await deployer.sendTransaction({ to: vault.address, value: gross });

    await captureCity(vault, bob, 0);
    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      oldOwnerShare,
    );
    assert.equal(await vault.read.pendingCityDividend([0]), 0n);

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await outsiderVault.write.settleCity([0]);
    assert.equal(
      await vault.read.claimableDividend([bob.account.address]),
      0n,
    );
  });

  it("checkpoints sub-threshold revenue at the old weight before the fifth capture upgrades", async function () {
    const { deployer, alice, bob, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    for (const captor of [bob, alice, bob, alice]) {
      await captureCity(vault, captor, 0);
    }

    const gross = parseEther("10");
    const dividend = parseEther("7");
    const oldIndexIncrease = (dividend * 10n ** 27n) / CITY_COUNT;
    const oldWeightShare = oldIndexIncrease / 10n ** 27n;
    await deployer.sendTransaction({ to: vault.address, value: gross });

    await captureCity(vault, bob, 0);

    const upgraded = cityView(await vault.read.getCity([0]));
    assert.equal(upgraded.level, 2);
    assert.equal(upgraded.weight, 2);
    assert.equal(await vault.read.accDividendPerWeight(), oldIndexIncrease);
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      oldWeightShare,
    );
    assert.equal(await vault.read.pendingCityDividend([0]), 0n);

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await outsiderVault.write.settleCity([0]);
    assert.equal(
      await vault.read.claimableDividend([bob.account.address]),
      0n,
    );
  });

  it("gives occupied weight its exact share while reserving vacant-city weight", async function () {
    const { deployer, alice, bob, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);
    await claimCity(vault, bob, 1);
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await outsiderVault.write.settleCity([0]);
    await outsiderVault.write.settleCity([1]);

    const dividend = parseEther("70");
    const oneWeightShare = dividend / CITY_COUNT;
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      oneWeightShare,
    );
    assert.equal(
      await vault.read.claimableDividend([bob.account.address]),
      oneWeightShare,
    );
    assert.equal(
      await vault.read.vacancyReserve(),
      (dividend * 54n) / CITY_COUNT,
    );
  });

  it("releases vacancy reserve across all weights when the 56th city is claimed", async function () {
    const { deployer, alice, bob, carol, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);

    // Give city 0 weight two, then occupy 54 more weight-one cities. Before the
    // last claim the active set has 56 occupied weights plus one vacant weight.
    await claimCity(vault, alice, 0);
    await performCaptureCycle(vault, bob, alice);
    for (let cityId = 1; cityId < 55; cityId += 1) {
      await claimCity(vault, alice, cityId);
    }
    assert.equal(BigInt(await vault.read.occupiedCityCount()), 55n);
    assert.equal(BigInt(await vault.read.vacantWeight()), 1n);
    assert.equal(BigInt(await vault.read.totalWeight()), 57n);

    // ceil(570/7) BNB stays below threshold. Its 57 BNB 70%-route dividend
    // divides exactly into 57 weights: 56 BNB for occupied weights and 1 BNB
    // vacancy reserve. The ceiling is necessary because native BNB is wei
    // denominated and 570e18 is not divisible by 7.
    const gross = (parseEther("570") + 6n) / 7n;
    await deployer.sendTransaction({
      to: vault.address,
      value: gross,
    });
    assert.equal(await vault.read.undispatchedRevenue(), gross);

    const precision = 10n ** 27n;
    const preClaimIndex = parseEther("1") * precision;
    const releasedReserve = parseEther("1");
    const releaseIndex = (releasedReserve * precision) / 57n;
    const finalIndex = preClaimIndex + releaseIndex;
    const carolVault = await asWallet("CityVault", vault.address, carol);

    await viem.assertions.emitWithArgs(
      carolVault.write.claimCity([55, FIRST_CLAIM_PRICE]),
      vault,
      "VacancyReserveReleased",
      [releasedReserve, 57n, finalIndex],
    );

    assert.equal(BigInt(await vault.read.occupiedCityCount()), 56n);
    assert.equal(BigInt(await vault.read.vacantWeight()), 0n);
    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(await vault.read.vacancyReserve(), 0n);
    assert.equal(
      await vault.read.compensationAvailable(),
      gross - parseEther("57"),
    );
    assert.equal(await vault.read.accDividendPerWeight(), finalIndex);

    const lastCityShare = releaseIndex / precision;
    const oldWeightOneShare = BigInt(await vault.read.pendingCityDividend([1]));
    const oldWeightTwoShare = BigInt(await vault.read.pendingCityDividend([0]));
    assert.equal(
      BigInt(await vault.read.pendingCityDividend([55])),
      lastCityShare,
    );
    assert.equal(
      oldWeightOneShare - parseEther("1"),
      lastCityShare,
    );
    assert.equal(
      oldWeightTwoShare - parseEther("2"),
      (2n * releaseIndex) / precision,
    );
    assert(lastCityShare < releasedReserve);

    // Settle every city and reconcile all native liabilities. The only
    // unassigned value may be sub-wei-per-weight floor dust from the release.
    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    for (let cityId = 0; cityId < 56; cityId += 1) {
      await outsiderVault.write.settleCity([cityId]);
    }
    const totalClaimable =
      BigInt(await vault.read.claimableDividend([alice.account.address])) +
      BigInt(await vault.read.claimableDividend([bob.account.address])) +
      BigInt(await vault.read.claimableDividend([carol.account.address]));
    const publicClient = await viem.getPublicClient();
    const vaultBalance = await publicClient.getBalance({ address: vault.address });
    const accounted =
      totalClaimable + BigInt(await vault.read.compensationAvailable());
    const roundingDust = vaultBalance - accounted;
    assert(roundingDust >= 0n);
    assert(roundingDust < 57n);
  });

  it("settles the ownership boundary so old and new owners only earn their own intervals", async function () {
    const { deployer, alice, bob, outsider, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);

    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);
    await captureCity(vault, bob, 0);
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);

    const outsiderVault = await asWallet("CityVault", vault.address, outsider);
    await outsiderVault.write.settleCity([0]);

    const intervalShare = parseEther("70") / CITY_COUNT;
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      intervalShare,
    );
    assert.equal(
      await vault.read.claimableDividend([bob.account.address]),
      intervalShare,
    );

    const aliceVault = await asWallet("CityVault", vault.address, alice);
    await viem.assertions.balancesHaveChanged(aliceVault.write.claimRevenue(), [
      { address: alice.account.address, amount: intervalShare },
      { address: vault.address, amount: -intervalShare },
    ]);
    assert.equal(
      await vault.read.claimableDividend([alice.account.address]),
      0n,
    );
  });

  it("allocates a deterministic funded share, creates no debt, and pays only on pull", async function () {
    const { deployer, alice, bob, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);

    await performCaptureCycle(vault, bob, alice);

    const remainingPool = BigInt(await vault.read.compensationAvailable());
    const credit = BigInt(
      await vault.read.claimableCompensation([bob.account.address]),
    );
    assert.equal(credit, parseEther("30") / 112n);
    assert.equal(remainingPool + credit, parseEther("30"));

    const bobVault = await asWallet("CityVault", vault.address, bob);
    await viem.assertions.balancesHaveChanged(bobVault.write.claimRevenue(), [
      { address: bob.account.address, amount: credit },
      { address: vault.address, amount: -credit },
    ]);
    assert.equal(
      await vault.read.claimableCompensation([bob.account.address]),
      0n,
    );

    // Later pool deposits cannot retroactively create compensation debt.
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);
    assert.equal(
      await vault.read.claimableCompensation([bob.account.address]),
      0n,
    );
  });

  it("reverts if minimum compensation exceeds the deterministic fair share", async function () {
    const { deployer, alice, bob, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);

    const captors = [bob, alice, bob, alice];
    for (const captor of captors) {
      await captureCity(vault, captor, 0);
    }

    const before = cityView(await vault.read.getCity([0]));
    const quote = captureQuote(await vault.read.quoteCapture([0]));
    const bobVault = await asWallet("CityVault", vault.address, bob);
    await viem.assertions.revertWithCustomError(
      bobVault.write.captureCity([
        0,
        quote.requiredPayment,
        await deadlineAfter(),
        parseEther("30") / 112n + 1n,
      ]),
      vault,
      "CompensationBelowMinimum",
    );
    const afterRevert = cityView(await vault.read.getCity([0]));
    assert.deepEqual(afterRevert, before);

    await captureCity(vault, bob, 0, 0n);
    const upgraded = cityView(await vault.read.getCity([0]));
    assert.equal(upgraded.level, 2);
    assert.equal(
      await vault.read.claimableCompensation([bob.account.address]),
      parseEther("30") / 112n,
    );
    assert.equal(
      await vault.read.compensationAvailable(),
      parseEther("30") - parseEther("30") / 112n,
    );
  });

  it("does not push native revenue to a rejecting owner during capture", async function () {
    const { deployer, alice, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);
    const rejecting = (await viem.deployContract(
      "RejectingNativeReceiver",
    )) as LooseContract;

    await erc20.write.mint([rejecting.address, LARGE_TOKEN_BALANCE]);
    await rejecting.write.approveToken([
      erc20.address,
      vault.address,
      maxUint256,
    ]);
    await rejecting.write.claimCity([vault.address, 0]);

    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);
    await captureCity(vault, alice, 0);

    const credit = await vault.read.claimableDividend([rejecting.address]);
    assert.equal(credit, parseEther("70") / CITY_COUNT);
    await viem.assertions.revertWithCustomError(
      rejecting.write.claimRevenue([vault.address]),
      vault,
      "NativeTransferFailed",
    );
    assert.equal(
      await vault.read.claimableDividend([rejecting.address]),
      credit,
    );
  });

  it("pays the entire pool to the final upgrade slot, then routes future revenue 100/0", async function () {
    const { deployer, alice, bob, vault } =
      await networkHelpers.loadFixture(deployFinalSlotFixture);
    await claimCity(vault, alice, 0);
    await vault.write.setRemainingUpgradeSlotsForTest([1]);

    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);
    const precision = 10n ** 27n;
    const firstDividendIndex = (parseEther("70") * precision) / 56n;
    assert.equal(await vault.read.accDividendPerWeight(), firstDividendIndex);
    assert.equal(await vault.read.compensationAvailable(), parseEther("30"));

    await performCaptureCycle(vault, bob, alice);

    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 0n);
    assert.equal(await vault.read.compensationPoolClosed(), true);
    assert.equal(
      await vault.read.claimableCompensation([bob.account.address]),
      parseEther("30"),
    );
    assert.equal(await vault.read.compensationAvailable(), 0n);

    assert.equal(
      await vault.read.accDividendPerWeight(),
      firstDividendIndex,
    );

    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);
    const futureDividendIndex = (DISPATCH_THRESHOLD * precision) / 57n;
    assert.equal(await vault.read.compensationAvailable(), 0n);
    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(
      await vault.read.accDividendPerWeight(),
      firstDividendIndex + futureDividendIndex,
    );
  });

  it("blocks a malicious token callback during the immediate previous-owner payment", async function () {
    const { alice, bob, erc20, vault } =
      await networkHelpers.loadFixture(deployReentrantFixture);
    await claimCity(vault, alice, 0);

    const reentryCalldata = encodeFunctionData({
      abi: vault.abi,
      functionName: "claimCity",
      args: [1, FIRST_CLAIM_PRICE],
    });
    await erc20.write.configureHook([
      vault.address,
      alice.account.address,
      reentryCalldata,
    ]);

    await captureCity(vault, bob, 0);

    assert.equal(await erc20.read.reentryAttempted(), true);
    assert.equal(await erc20.read.reentrySucceeded(), false);
    const revertData = String(await erc20.read.reentryReturnData());
    assert.equal(
      revertData.slice(0, 10).toLowerCase(),
      toFunctionSelector("ReentrancyGuardReentrantCall()").toLowerCase(),
    );
    const untouched = cityView(await vault.read.getCity([1]));
    assert.equal(untouched.owner, zeroAddress);
    const captured = cityView(await vault.read.getCity([0]));
    assert.equal(captured.owner.toLowerCase(), bob.account.address.toLowerCase());
  });

  it("stops upgrades and compensation at Lv.3 while captures remain possible", async function () {
    const { deployer, alice, bob, erc20, vault } =
      await networkHelpers.loadFixture(deployFixture);
    await claimCity(vault, alice, 0);
    await sendNativeRevenue(vault, deployer, DISPATCH_THRESHOLD);

    await performCaptureCycle(vault, bob, alice);
    let city = cityView(await vault.read.getCity([0]));
    assert.equal(city.level, 2);
    assert.equal(city.weight, 2);
    assert.equal(city.anchorPrice, LEVEL_TWO_PRICE);

    // Alice owns the city after the first helper's fifth capture? The helper's
    // firstCaptor owns it, so alternate from the current owner for cycle two.
    await performCaptureCycle(vault, alice, bob);
    city = cityView(await vault.read.getCity([0]));
    assert.equal(city.level, 3);
    assert.equal(city.weight, 3);
    assert.equal(city.anchorPrice, LEVEL_THREE_PRICE);
    assert.equal(BigInt(await vault.read.totalWeight()), 58n);

    const poolBeforeLv3Cycle = await vault.read.compensationAvailable();
    await performCaptureCycle(vault, bob, alice);
    city = cityView(await vault.read.getCity([0]));
    assert.equal(city.level, 3);
    assert.equal(city.weight, 3);
    assert.equal(city.capturesInCycle, 0);
    assert.equal(city.anchorPrice, LEVEL_THREE_ANCHOR_CAP);
    assert.equal(BigInt(await vault.read.totalWeight()), 58n);
    assert.equal(
      await vault.read.compensationAvailable(),
      poolBeforeLv3Cycle,
    );

    const terminalQuote = captureQuote(await vault.read.quoteCapture([0]));
    assert.equal(terminalQuote.referencePrice, token("4798248"));
    assert.equal(terminalQuote.requiredPayment, token("6237722.4"));
    assert.equal(terminalQuote.previousOwnerAmount, token("5757897.6"));
    assert.equal(terminalQuote.burnAmount, token("479824.8"));

    const aliceBefore = await erc20.read.balanceOf([alice.account.address]);
    const bobBefore = await erc20.read.balanceOf([bob.account.address]);
    const blackHole = await vault.read.BLACK_HOLE();
    const blackHoleBefore = await erc20.read.balanceOf([blackHole]);
    await captureCity(vault, alice, 0);

    assert.equal(
      await erc20.read.balanceOf([alice.account.address]),
      aliceBefore - token("6237722.4"),
    );
    assert.equal(
      await erc20.read.balanceOf([bob.account.address]),
      bobBefore + token("5757897.6"),
    );
    assert.equal(
      await erc20.read.balanceOf([blackHole]),
      blackHoleBefore + token("479824.8"),
    );
    city = cityView(await vault.read.getCity([0]));
    assert.equal(city.anchorPrice, LEVEL_THREE_ANCHOR_CAP);
    assert.equal(city.capturesInCycle, 1);
  });
});
