import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  maxUint256,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";

const connection = await network.create();
const { viem, networkHelpers } = connection;

const CITY_COUNT = 56;
const MAX_LEVEL = 3;
const FIRST_CLAIM_PRICE = parseUnits("560000", 18);
const LEVEL_THREE_BASE_PRICE = parseUnits("1680000", 18);
const LEVEL_THREE_TERMINAL_ANCHOR = parseUnits("4798248", 18);
const LEVEL_THREE_TERMINAL_PAYMENT = parseUnits("6237722.4", 18);
const LEVEL_THREE_TERMINAL_OWNER_AMOUNT = parseUnits("5757897.6", 18);
const LEVEL_THREE_TERMINAL_BURN = parseUnits("479824.8", 18);
const TOKEN_BALANCE = parseUnits("50000000000", 18);
const DISPATCH_THRESHOLD = parseEther("1");
const NO_CAPTURE_DELAY = 0n;
const ACC_PRECISION = 10n ** 27n;
const FLAP_RECEIVE_GAS_BUDGET = 1_000_000n;

type LooseContract = any;
type LooseWallet = any;

function tupleField<T>(value: any, name: string, index: number): T {
  return (value?.[name] ?? value?.[index]) as T;
}

function cityView(raw: any) {
  return {
    owner: tupleField<string>(raw, "owner", 0),
    lastCaptureAt: BigInt(
      tupleField<bigint | number>(raw, "lastCaptureAt", 1),
    ),
    level: Number(tupleField<bigint | number>(raw, "level", 2)),
    weight: Number(tupleField<bigint | number>(raw, "weight", 3)),
    capturesInCycle: Number(
      tupleField<bigint | number>(raw, "capturesInCycle", 4),
    ),
    anchorPrice: BigInt(tupleField<bigint>(raw, "anchorPrice", 5)),
    rewardDebtScaled: BigInt(
      tupleField<bigint>(raw, "rewardDebtScaled", 6),
    ),
  };
}

function captureQuote(raw: any) {
  return {
    referencePrice: BigInt(tupleField<bigint>(raw, "referencePrice", 0)),
    payment: BigInt(tupleField<bigint>(raw, "payment", 1)),
    previousOwnerAmount: BigInt(
      tupleField<bigint>(raw, "previousOwnerAmount", 2),
    ),
    burnAmount: BigInt(tupleField<bigint>(raw, "burnAmount", 3)),
  };
}

function assertCaptureSplit(raw: any, context: string) {
  const quote = captureQuote(raw);
  const expectedPayment = (quote.referencePrice * 13_000n) / 10_000n;
  const expectedOwnerAmount = (quote.referencePrice * 12_000n) / 10_000n;
  const expectedBurnAmount = (quote.referencePrice * 1_000n) / 10_000n;

  assert.equal(quote.payment, expectedPayment, `${context}: payment is not 130%`);
  assert.equal(
    quote.previousOwnerAmount,
    expectedOwnerAmount,
    `${context}: previous owner amount is not 120%`,
  );
  assert.equal(
    quote.burnAmount,
    expectedBurnAmount,
    `${context}: black-hole amount is not 10%`,
  );
  assert.equal(
    quote.payment,
    quote.previousOwnerAmount + quote.burnAmount,
    `${context}: 130% does not equal 120% + 10%`,
  );

  return quote;
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
  assert(wallets.length >= 10, "the invariant fixture requires ten local wallets");

  const [deployer, treasury] = wallets;
  const actors = wallets.slice(2, 10);
  const erc20 = (await viem.deployContract("MockERC20")) as LooseContract;
  const vault = (await viem.deployContract("CityVault", [
    erc20.address,
    deployer.account.address,
    treasury.account.address,
    DISPATCH_THRESHOLD,
    NO_CAPTURE_DELAY,
  ])) as LooseContract;

  for (const actor of actors) {
    await erc20.write.mint([actor.account.address, TOKEN_BALANCE]);
    const actorToken = await asWallet("MockERC20", erc20.address, actor);
    await actorToken.write.approve([vault.address, maxUint256]);
  }

  return {
    wallets,
    deployer,
    treasury,
    actors,
    erc20,
    vault,
    publicClient: await viem.getPublicClient(),
  };
}

async function deadlineAfter(seconds = 3_600n) {
  return BigInt(await networkHelpers.time.latest()) + seconds;
}

async function executeCapture(
  vault: LooseContract,
  actor: LooseWallet,
  cityId: number,
) {
  const rawQuote = await vault.read.quoteCapture([cityId]);
  const quote = assertCaptureSplit(rawQuote, `execute capture city ${cityId}`);
  const actorVault = await asWallet("CityVault", vault.address, actor);
  const hash = (await actorVault.write.captureCity([
    cityId,
    quote.payment,
    await deadlineAfter(),
    0n,
  ])) as `0x${string}`;
  return { hash, quote };
}

function fixedSeedRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe("CityVault deterministic state invariants and gas", { concurrency: false }, function () {
  it("preserves aggregate city state and native-asset liabilities through a fixed-seed action sequence", async function () {
    const { wallets, deployer, treasury, actors, erc20, vault, publicClient } =
      await networkHelpers.loadFixture(deployFixture);

    const knownAccounts = Array.from(
      new Map(
        wallets.map((wallet) => [
          wallet.account.address.toLowerCase(),
          wallet.account.address,
        ]),
      ).values(),
    );
    const claimedCityIds = new Set<number>();
    const actionCounts = {
      claimCity: 0,
      captureCity: 0,
      revenue: 0,
      settleCity: 0,
      claimRevenue: 0,
    };
    let invariantChecks = 0;
    let largestUnassignedRoundingDust = 0n;

    async function assertAllInvariants(context: string) {
      const rawCities = await Promise.all(
        Array.from({ length: CITY_COUNT }, (_, cityId) =>
          vault.read.getCity([cityId]),
        ),
      );
      const cities = rawCities.map(cityView);
      const pending = await Promise.all(
        Array.from({ length: CITY_COUNT }, (_, cityId) =>
          vault.read.pendingCityDividend([cityId]),
        ),
      );

      let occupied = 0n;
      let totalWeight = 0n;
      let vacantWeight = 0n;
      let remainingUpgradeSlots = 0n;
      let allCityPending = 0n;
      const occupiedIds: number[] = [];

      for (let cityId = 0; cityId < CITY_COUNT; cityId += 1) {
        const city = cities[cityId];
        assert(city.level >= 1 && city.level <= MAX_LEVEL, `${context}: invalid level`);
        assert.equal(
          city.weight,
          city.level,
          `${context}: city ${cityId} weight must track its level`,
        );

        totalWeight += BigInt(city.weight);
        remainingUpgradeSlots += BigInt(MAX_LEVEL - city.level);
        allCityPending += BigInt(pending[cityId]);

        if (city.owner.toLowerCase() === zeroAddress) {
          vacantWeight += BigInt(city.weight);
          assert.equal(city.level, 1, `${context}: a vacant city was upgraded`);
        } else {
          occupied += 1n;
          occupiedIds.push(cityId);
        }
      }

      assert.equal(
        BigInt(await vault.read.totalWeight()),
        totalWeight,
        `${context}: totalWeight differs from the 56-city sum`,
      );
      assert.equal(
        BigInt(await vault.read.vacantWeight()),
        vacantWeight,
        `${context}: vacantWeight differs from the vacant-city sum`,
      );
      assert.equal(
        BigInt(await vault.read.occupiedCityCount()),
        occupied,
        `${context}: occupiedCityCount differs from the occupied-city sum`,
      );
      assert.equal(
        BigInt(await vault.read.remainingUpgradeSlots()),
        remainingUpgradeSlots,
        `${context}: remainingUpgradeSlots differs from the 56-city sum`,
      );

      const quotes = await Promise.all(
        occupiedIds.map((cityId) => vault.read.quoteCapture([cityId])),
      );
      quotes.forEach((quote, index) =>
        assertCaptureSplit(
          quote,
          `${context}: city ${occupiedIds[index]} capture quote`,
        ),
      );

      const credits = await Promise.all(
        knownAccounts.map(async (account) => {
          const [dividend, compensation] = await Promise.all([
            vault.read.claimableDividend([account]),
            vault.read.claimableCompensation([account]),
          ]);
          return BigInt(dividend) + BigInt(compensation);
        }),
      );
      const allKnownAccountClaimable = credits.reduce(
        (sum, credit) => sum + credit,
        0n,
      );

      const [balance, undispatched, compensation, vacancy] = await Promise.all([
        publicClient.getBalance({ address: vault.address }),
        vault.read.undispatchedRevenue(),
        vault.read.compensationAvailable(),
        vault.read.vacancyReserve(),
      ]);
      const accountedLowerBound =
        BigInt(undispatched) +
        BigInt(compensation) +
        BigInt(vacancy) +
        allKnownAccountClaimable +
        allCityPending;

      assert(
        balance >= accountedLowerBound,
        `${context}: vault balance ${balance} is below accounted liabilities ${accountedLowerBound}`,
      );
      const unassignedRoundingDust = balance - accountedLowerBound;
      if (unassignedRoundingDust > largestUnassignedRoundingDust) {
        largestUnassignedRoundingDust = unassignedRoundingDust;
      }
      invariantChecks += 1;
    }

    async function checkedAction(
      action: keyof typeof actionCounts,
      run: () => Promise<unknown>,
    ) {
      await run();
      actionCounts[action] += 1;
      await assertAllInvariants(`${action} #${actionCounts[action]}`);
    }

    async function claim(cityId: number, actor: LooseWallet) {
      const actorVault = await asWallet("CityVault", vault.address, actor);
      const treasuryBefore = BigInt(
        await erc20.read.balanceOf([treasury.account.address]),
      );
      await actorVault.write.claimCity([cityId, FIRST_CLAIM_PRICE]);
      assert.equal(
        BigInt(await erc20.read.balanceOf([treasury.account.address])),
        treasuryBefore + FIRST_CLAIM_PRICE,
      );
      claimedCityIds.add(cityId);
    }

    async function capture(cityId: number, actor: LooseWallet) {
      const cityBefore = cityView(await vault.read.getCity([cityId]));
      assert.notEqual(cityBefore.owner.toLowerCase(), actor.account.address.toLowerCase());
      const rawQuote = await vault.read.quoteCapture([cityId]);
      const quote = assertCaptureSplit(rawQuote, `capture city ${cityId}`);
      const blackHole = await vault.read.BLACK_HOLE();
      const [actorBefore, ownerBefore, blackHoleBefore] = await Promise.all([
        erc20.read.balanceOf([actor.account.address]),
        erc20.read.balanceOf([cityBefore.owner]),
        erc20.read.balanceOf([blackHole]),
      ]);

      const actorVault = await asWallet("CityVault", vault.address, actor);
      await actorVault.write.captureCity([
        cityId,
        quote.payment,
        await deadlineAfter(),
        0n,
      ]);

      const [actorAfter, ownerAfter, blackHoleAfter, vaultTokenBalance] =
        await Promise.all([
          erc20.read.balanceOf([actor.account.address]),
          erc20.read.balanceOf([cityBefore.owner]),
          erc20.read.balanceOf([blackHole]),
          erc20.read.balanceOf([vault.address]),
        ]);
      assert.equal(BigInt(actorAfter), BigInt(actorBefore) - quote.payment);
      assert.equal(
        BigInt(ownerAfter),
        BigInt(ownerBefore) + quote.previousOwnerAmount,
      );
      assert.equal(
        BigInt(blackHoleAfter),
        BigInt(blackHoleBefore) + quote.burnAmount,
      );
      assert.equal(BigInt(vaultTokenBalance), 0n, "capture left tax tokens in the vault");
    }

    await assertAllInvariants("initial state");

    // Deterministic bootstrap guarantees coverage of all five action classes
    // and one complete five-capture upgrade before the pseudo-random tail.
    await checkedAction("claimCity", () => claim(0, actors[0]));
    await checkedAction("revenue", () =>
      deployer.sendTransaction({
        to: vault.address,
        value: DISPATCH_THRESHOLD / 3n,
      }),
    );
    await checkedAction("revenue", () =>
      deployer.sendTransaction({
        to: vault.address,
        value: DISPATCH_THRESHOLD - DISPATCH_THRESHOLD / 3n,
      }),
    );
    await checkedAction("settleCity", async () => {
      const actorVault = await asWallet("CityVault", vault.address, actors[1]);
      await actorVault.write.settleCity([0]);
    });
    await checkedAction("claimRevenue", async () => {
      const actorVault = await asWallet("CityVault", vault.address, actors[0]);
      await actorVault.write.claimRevenue();
    });

    for (let captureNumber = 0; captureNumber < 5; captureNumber += 1) {
      const current = cityView(await vault.read.getCity([0]));
      const actor = actors.find(
        (candidate) =>
          candidate.account.address.toLowerCase() !== current.owner.toLowerCase(),
      );
      assert(actor !== undefined);
      await checkedAction("captureCity", () => capture(0, actor));
    }
    assert.equal(cityView(await vault.read.getCity([0])).level, 2);

    const random = fixedSeedRandom(0x56c17a11);
    for (let step = 0; step < 72; step += 1) {
      const creditRows = await Promise.all(
        actors.map(async (actor) => ({
          actor,
          credit:
            BigInt(await vault.read.claimableDividend([actor.account.address])) +
            BigInt(await vault.read.claimableCompensation([actor.account.address])),
        })),
      );
      const claimableActors = creditRows
        .filter((row) => row.credit !== 0n)
        .map((row) => row.actor);
      const vacantIds = Array.from({ length: CITY_COUNT }, (_, id) => id).filter(
        (id) => !claimedCityIds.has(id),
      );
      const occupiedIds = [...claimedCityIds];

      const availableActions: Array<keyof typeof actionCounts> = ["revenue"];
      if (vacantIds.length !== 0) availableActions.push("claimCity");
      if (occupiedIds.length !== 0) {
        availableActions.push("captureCity", "settleCity");
      }
      if (claimableActors.length !== 0) availableActions.push("claimRevenue");

      const action = availableActions[random() % availableActions.length];
      if (action === "claimCity") {
        const cityId = vacantIds[random() % vacantIds.length];
        const actor = actors[random() % actors.length];
        await checkedAction(action, () => claim(cityId, actor));
      } else if (action === "captureCity") {
        const cityId = occupiedIds[random() % occupiedIds.length];
        const current = cityView(await vault.read.getCity([cityId]));
        const eligibleActors = actors.filter(
          (actor) =>
            actor.account.address.toLowerCase() !== current.owner.toLowerCase(),
        );
        const actor = eligibleActors[random() % eligibleActors.length];
        await checkedAction(action, () => capture(cityId, actor));
      } else if (action === "settleCity") {
        const cityId = occupiedIds[random() % occupiedIds.length];
        const actor = actors[random() % actors.length];
        await checkedAction(action, async () => {
          const actorVault = await asWallet("CityVault", vault.address, actor);
          await actorVault.write.settleCity([cityId]);
        });
      } else if (action === "claimRevenue") {
        const actor = claimableActors[random() % claimableActors.length];
        await checkedAction(action, async () => {
          const actorVault = await asWallet("CityVault", vault.address, actor);
          await actorVault.write.claimRevenue();
        });
      } else {
        const tenths = BigInt((random() % 15) + 1);
        await checkedAction("revenue", () =>
          deployer.sendTransaction({
            to: vault.address,
            value: (DISPATCH_THRESHOLD * tenths) / 10n,
          }),
        );
      }
    }

    for (const [action, count] of Object.entries(actionCounts)) {
      assert(count > 0, `fixed seed did not execute ${action}`);
    }
    assert(invariantChecks >= 80, "too few continuous invariant checkpoints");

    console.info(
      `[CityVault invariant] checks=${invariantChecks} actions=${JSON.stringify(actionCounts)} max-unassigned-rounding-dust-wei=${largestUnassignedRoundingDust}`,
    );
  });

  it("releases the final vacancy reserve with scaled carry and gives the 56th claimant no more than one weight", async function () {
    const { wallets, deployer, actors, vault, publicClient } =
      await networkHelpers.loadFixture(deployFixture);
    const [alice, bob, finalClaimant] = actors;
    const aliceVault = await asWallet("CityVault", vault.address, alice);

    await aliceVault.write.claimCity([0, FIRST_CLAIM_PRICE]);
    for (let captureNumber = 0; captureNumber < 5; captureNumber += 1) {
      const current = cityView(await vault.read.getCity([0]));
      const actor =
        current.owner.toLowerCase() === alice.account.address.toLowerCase()
          ? bob
          : alice;
      await executeCapture(vault, actor, 0);
    }
    assert.equal(cityView(await vault.read.getCity([0])).level, 2);

    // Occupy 55 cities while retaining one vacant base weight. City 0's
    // upgrade makes the denominator 57, which also exercises non-zero scaled
    // vacancy carry rather than an exactly divisible toy amount.
    for (let cityId = 1; cityId < 55; cityId += 1) {
      await aliceVault.write.claimCity([cityId, FIRST_CLAIM_PRICE]);
    }
    assert.equal(BigInt(await vault.read.occupiedCityCount()), 55n);
    assert.equal(BigInt(await vault.read.vacantWeight()), 1n);
    assert.equal(BigInt(await vault.read.totalWeight()), 57n);
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 111n);

    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD,
    });

    const dividendAmount = (DISPATCH_THRESHOLD * 7_000n) / 10_000n;
    const expectedPreReleaseIndex =
      (dividendAmount * ACC_PRECISION) / 57n;
    const expectedVacancyReserve = expectedPreReleaseIndex / ACC_PRECISION;
    const expectedVacancyCarry = expectedPreReleaseIndex % ACC_PRECISION;
    assert(expectedVacancyCarry !== 0n, "fixture must exercise scaled carry");
    assert.equal(
      BigInt(await vault.read.accDividendPerWeight()),
      expectedPreReleaseIndex,
    );
    assert.equal(
      BigInt(await vault.read.vacancyReserve()),
      expectedVacancyReserve,
    );

    async function sumPending() {
      const values = await Promise.all(
        Array.from({ length: CITY_COUNT }, (_, cityId) =>
          vault.read.pendingCityDividend([cityId]),
        ),
      );
      return values.reduce((sum, amount) => sum + BigInt(amount), 0n);
    }

    async function sumKnownClaimables() {
      const rows = await Promise.all(
        wallets.map(async (wallet) => {
          const [dividend, compensation] = await Promise.all([
            vault.read.claimableDividend([wallet.account.address]),
            vault.read.claimableCompensation([wallet.account.address]),
          ]);
          return BigInt(dividend) + BigInt(compensation);
        }),
      );
      return rows.reduce((sum, amount) => sum + amount, 0n);
    }

    const [balanceBefore, pendingBefore, claimableBefore, compensationBefore] =
      await Promise.all([
        publicClient.getBalance({ address: vault.address }),
        sumPending(),
        sumKnownClaimables(),
        vault.read.compensationAvailable(),
      ]);
    const liabilitiesBefore =
      pendingBefore +
      claimableBefore +
      BigInt(compensationBefore) +
      expectedVacancyReserve;
    assert(balanceBefore >= liabilitiesBefore);
    const dustBefore = balanceBefore - liabilitiesBefore;

    const finalVault = await asWallet(
      "CityVault",
      vault.address,
      finalClaimant,
    );
    const finalClaimHash = (await finalVault.write.claimCity([
      55,
      FIRST_CLAIM_PRICE,
    ])) as `0x${string}`;
    const finalClaimReceipt = await publicClient.waitForTransactionReceipt({
      hash: finalClaimHash,
    });
    assert.equal(finalClaimReceipt.status, "success");
    assert(finalClaimReceipt.gasUsed < FLAP_RECEIVE_GAS_BUDGET);

    const expectedReleaseIndex =
      (expectedVacancyReserve * ACC_PRECISION + expectedVacancyCarry) / 57n;
    assert.equal(
      BigInt(await vault.read.accDividendPerWeight()),
      expectedPreReleaseIndex + expectedReleaseIndex,
      "release index did not include the prior scaled vacancy carry",
    );
    assert.equal(BigInt(await vault.read.occupiedCityCount()), 56n);
    assert.equal(BigInt(await vault.read.vacantWeight()), 0n);
    assert.equal(BigInt(await vault.read.totalWeight()), 57n);
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 111n);
    assert.equal(BigInt(await vault.read.vacancyReserve()), 0n);
    assert.equal(BigInt(await vault.read.undispatchedRevenue()), 0n);

    const finalCityPending = BigInt(
      await vault.read.pendingCityDividend([55]),
    );
    const expectedOneWeightShare = expectedReleaseIndex / ACC_PRECISION;
    assert.equal(
      finalCityPending,
      expectedOneWeightShare,
      "the final claimant did not receive exactly one normal weight",
    );
    assert.equal(
      finalCityPending,
      expectedVacancyReserve / 57n,
      "the final claimant extracted more than its one-weight reserve share",
    );
    assert(finalCityPending < expectedVacancyReserve);

    const [balanceAfter, pendingAfter, claimableAfter, compensationAfter] =
      await Promise.all([
        publicClient.getBalance({ address: vault.address }),
        sumPending(),
        sumKnownClaimables(),
        vault.read.compensationAvailable(),
      ]);
    assert.equal(balanceAfter, balanceBefore, "a token-only claim moved native BNB");
    assert.equal(BigInt(compensationAfter), BigInt(compensationBefore));

    const liabilitiesAfter =
      pendingAfter + claimableAfter + BigInt(compensationAfter);
    assert(balanceAfter >= liabilitiesAfter);
    const dustAfter = balanceAfter - liabilitiesAfter;
    const dustLimit = 2n * BigInt(CITY_COUNT) + 4n;
    assert(
      dustBefore < dustLimit && dustAfter < dustLimit,
      `vacancy release left excessive rounding dust: before=${dustBefore}, after=${dustAfter}`,
    );

    console.info(
      `[CityVault vacancy release] reserve-wei=${expectedVacancyReserve} final-one-weight-share-wei=${finalCityPending} dust-before-wei=${dustBefore} dust-after-wei=${dustAfter} final-claim-gas=${finalClaimReceipt.gasUsed}`,
    );
  });

  it("holds the Lv.3 terminal payment constant across repeated five-capture display cycles", async function () {
    const { actors, vault, publicClient } =
      await networkHelpers.loadFixture(deployFixture);
    const [alice, bob] = actors;
    const aliceVault = await asWallet("CityVault", vault.address, alice);
    await aliceVault.write.claimCity([0, FIRST_CLAIM_PRICE]);

    // Two upgrade cycles enter Lv.3 at its 1.68m base reference.
    for (let captureNumber = 0; captureNumber < 10; captureNumber += 1) {
      const current = cityView(await vault.read.getCity([0]));
      const actor =
        current.owner.toLowerCase() === alice.account.address.toLowerCase()
          ? bob
          : alice;
      await executeCapture(vault, actor, 0);
    }

    let city = cityView(await vault.read.getCity([0]));
    assert.equal(city.level, 3);
    assert.equal(city.weight, 3);
    assert.equal(city.capturesInCycle, 0);
    assert.equal(city.anchorPrice, LEVEL_THREE_BASE_PRICE);
    assert.equal(BigInt(await vault.read.totalWeight()), 58n);
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 110n);
    const compensationBefore = BigInt(await vault.read.compensationAvailable());

    // Four ordinary compounding captures reach the terminal reference. The
    // fifth pays against that reference and closes the display cycle without
    // resetting the price downward.
    let expectedAnchor = LEVEL_THREE_BASE_PRICE;
    for (let captureNumber = 1; captureNumber <= 4; captureNumber += 1) {
      const current = cityView(await vault.read.getCity([0]));
      const actor =
        current.owner.toLowerCase() === alice.account.address.toLowerCase()
          ? bob
          : alice;
      const { quote } = await executeCapture(vault, actor, 0);
      assert.equal(quote.referencePrice, expectedAnchor);
      expectedAnchor =
        quote.payment < LEVEL_THREE_TERMINAL_ANCHOR
          ? quote.payment
          : LEVEL_THREE_TERMINAL_ANCHOR;
      city = cityView(await vault.read.getCity([0]));
      assert.equal(city.anchorPrice, expectedAnchor);
      assert.equal(city.capturesInCycle, captureNumber);
    }
    assert.equal(expectedAnchor, LEVEL_THREE_TERMINAL_ANCHOR);

    const currentBeforeBoundary = cityView(await vault.read.getCity([0]));
    const boundaryActor =
      currentBeforeBoundary.owner.toLowerCase() === alice.account.address.toLowerCase()
        ? bob
        : alice;
    const boundaryCapture = await executeCapture(vault, boundaryActor, 0);
    assert.equal(
      boundaryCapture.quote.referencePrice,
      LEVEL_THREE_TERMINAL_ANCHOR,
    );
    assert.equal(boundaryCapture.quote.payment, LEVEL_THREE_TERMINAL_PAYMENT);
    assert.equal(
      boundaryCapture.quote.previousOwnerAmount,
      LEVEL_THREE_TERMINAL_OWNER_AMOUNT,
    );
    assert.equal(boundaryCapture.quote.burnAmount, LEVEL_THREE_TERMINAL_BURN);
    const boundaryReceipt = await publicClient.waitForTransactionReceipt({
      hash: boundaryCapture.hash,
    });
    assert.equal(boundaryReceipt.status, "success");
    assert(boundaryReceipt.gasUsed < FLAP_RECEIVE_GAS_BUDGET);

    city = cityView(await vault.read.getCity([0]));
    assert.equal(city.anchorPrice, LEVEL_THREE_TERMINAL_ANCHOR);
    assert.equal(city.capturesInCycle, 0);
    const quoteImmediatelyAfterCycle = captureQuote(
      await vault.read.quoteCapture([0]),
    );
    assert.equal(
      quoteImmediatelyAfterCycle.referencePrice,
      boundaryCapture.quote.referencePrice,
      "Lv.3 reference price fell at the five-capture boundary",
    );
    assert.equal(
      quoteImmediatelyAfterCycle.payment,
      boundaryCapture.quote.payment,
      "Lv.3 payment fell at the five-capture boundary",
    );

    // Cross two more counter resets. Every terminal capture must retain the
    // same reference, payment, owner transfer and burn rather than compounding.
    for (let terminalCapture = 1; terminalCapture <= 10; terminalCapture += 1) {
      const quote = captureQuote(await vault.read.quoteCapture([0]));
      assert.equal(quote.referencePrice, LEVEL_THREE_TERMINAL_ANCHOR);
      assert.equal(quote.payment, LEVEL_THREE_TERMINAL_PAYMENT);
      assert.equal(
        quote.previousOwnerAmount,
        LEVEL_THREE_TERMINAL_OWNER_AMOUNT,
      );
      assert.equal(quote.burnAmount, LEVEL_THREE_TERMINAL_BURN);

      const current = cityView(await vault.read.getCity([0]));
      const actor =
        current.owner.toLowerCase() === alice.account.address.toLowerCase()
          ? bob
          : alice;
      await executeCapture(vault, actor, 0);
      city = cityView(await vault.read.getCity([0]));
      assert.equal(city.anchorPrice, LEVEL_THREE_TERMINAL_ANCHOR);
      assert.equal(city.capturesInCycle, terminalCapture % 5);
      assert.equal(city.level, 3);
      assert.equal(city.weight, 3);
    }

    assert.equal(BigInt(await vault.read.totalWeight()), 58n);
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 110n);
    assert.equal(
      BigInt(await vault.read.compensationAvailable()),
      compensationBefore,
    );

    console.info(
      `[CityVault Lv3 terminal] anchor=${LEVEL_THREE_TERMINAL_ANCHOR} payment=${LEVEL_THREE_TERMINAL_PAYMENT} cycle-boundary-gas=${boundaryReceipt.gasUsed}`,
    );
  });

  it("measures hot-path gas from transaction receipts against Flap's 1m receive budget", async function () {
    const { deployer, actors, vault, publicClient } =
      await networkHelpers.loadFixture(deployFixture);
    const [alice, bob, keeper] = actors;

    async function gasUsed(transaction: Promise<`0x${string}`>) {
      const hash = await transaction;
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt.gasUsed;
    }

    const samples: Record<string, bigint> = {};
    samples.receiveBelowThreshold = await gasUsed(
      deployer.sendTransaction({
        to: vault.address,
        value: DISPATCH_THRESHOLD - 1n,
      }),
    );
    samples.receiveAutoDispatch = await gasUsed(
      deployer.sendTransaction({ to: vault.address, value: 1n }),
    );

    const aliceVault = await asWallet("CityVault", vault.address, alice);
    samples.claimCity = await gasUsed(
      aliceVault.write.claimCity([0, FIRST_CLAIM_PRICE]),
    );

    // Give the occupied city a non-zero interval so the ordinary capture gas
    // includes checkpoint/settlement accounting as well as both token routes.
    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD,
    });
    let quote = assertCaptureSplit(await vault.read.quoteCapture([0]), "gas capture");
    const bobVault = await asWallet("CityVault", vault.address, bob);
    samples.captureCity = await gasUsed(
      bobVault.write.captureCity([
        0,
        quote.payment,
        await deadlineAfter(),
        0n,
      ]),
    );

    // Captures two through four set up the fifth, upgrade-triggering capture.
    for (const actor of [alice, bob, alice]) {
      quote = assertCaptureSplit(
        await vault.read.quoteCapture([0]),
        "gas upgrade setup",
      );
      const actorVault = await asWallet("CityVault", vault.address, actor);
      await actorVault.write.captureCity([
        0,
        quote.payment,
        await deadlineAfter(),
        0n,
      ]);
    }

    quote = assertCaptureSplit(
      await vault.read.quoteCapture([0]),
      "gas upgrade trigger",
    );
    samples.upgradeCapture = await gasUsed(
      bobVault.write.captureCity([
        0,
        quote.payment,
        await deadlineAfter(),
        0n,
      ]),
    );
    assert.equal(cityView(await vault.read.getCity([0])).level, 2);

    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD,
    });
    const keeperVault = await asWallet("CityVault", vault.address, keeper);
    samples.settleCity = await gasUsed(keeperVault.write.settleCity([0]));
    samples.claimRevenue = await gasUsed(bobVault.write.claimRevenue());

    for (const [name, used] of Object.entries(samples)) {
      assert(
        used < FLAP_RECEIVE_GAS_BUDGET,
        `${name} used ${used} gas, exceeding the 1m comparison budget`,
      );
    }

    const printable = Object.fromEntries(
      Object.entries(samples).map(([name, used]) => [name, used.toString()]),
    );
    console.info(
      `[CityVault gas] receipt-gas-used=${JSON.stringify(printable)}; all samples < ${FLAP_RECEIVE_GAS_BUDGET}`,
    );
  });
});
