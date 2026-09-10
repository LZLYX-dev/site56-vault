import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { maxUint256, parseEther, parseUnits } from "viem";

const connection = await network.create();
const { viem, networkHelpers } = connection;

const token = (amount: string) => parseUnits(amount, 18);
const CITY_COUNT = 56;
const FIRST_CLAIM_PRICE = token("560000");
const DISPATCH_THRESHOLD = parseEther("100");
const NO_CAPTURE_DELAY = 0n;
const PRECISION = 10n ** 27n;

// Exact required payments for five Lv.1 captures followed by five Lv.2
// captures. The fifth payment in each half upgrades the city and resets its
// anchor to the next level's fixed base price.
const CAPTURE_PAYMENTS = [
  token("728000"),
  token("946400"),
  token("1230320"),
  token("1599416"),
  token("2079240.8"),
  token("1456000"),
  token("1892800"),
  token("2460640"),
  token("3198832"),
  token("4158481.6"),
] as const;

const LEVEL_THREE_CAPTURE_PAYMENTS = [
  token("2184000"),
  token("2839200"),
  token("3690960"),
  token("4798248"),
  token("6237722.4"),
] as const;

type LooseContract = any;
type LooseWallet = any;

async function asWallet(
  contractName: string,
  address: `0x${string}`,
  wallet: LooseWallet,
): Promise<LooseContract> {
  return viem.getContractAt(contractName, address, {
    client: { wallet },
  }) as Promise<LooseContract>;
}

function tupleField<T>(value: any, name: string, index: number): T {
  return (value?.[name] ?? value?.[index]) as T;
}

function cityView(raw: any) {
  return {
    owner: tupleField<string>(raw, "owner", 0),
    level: Number(tupleField<number | bigint>(raw, "level", 2)),
    weight: Number(tupleField<number | bigint>(raw, "weight", 3)),
    capturesInCycle: Number(
      tupleField<number | bigint>(raw, "capturesInCycle", 4),
    ),
    anchorPrice: BigInt(tupleField<bigint>(raw, "anchorPrice", 5)),
  };
}

describe("CityVault full 56-city lifecycle", { concurrency: false }, function () {
  it("consumes all 112 real upgrade slots and permanently closes compensation", async function () {
    const wallets = await viem.getWalletClients();
    const [deployer, treasury, alice, bob] = wallets;

    const erc20 = (await viem.deployContract("MockERC20")) as LooseContract;
    const vault = (await viem.deployContract("CityVault", [
      erc20.address,
      deployer.account.address,
      treasury.account.address,
      DISPATCH_THRESHOLD,
      NO_CAPTURE_DELAY,
    ])) as LooseContract;

    const aliceToken = await asWallet("MockERC20", erc20.address, alice);
    const bobToken = await asWallet("MockERC20", erc20.address, bob);
    const aliceVault = await asWallet("CityVault", vault.address, alice);
    const bobVault = await asWallet("CityVault", vault.address, bob);

    // Batch-mint once per actor. These balances cover the entire lifecycle even
    // without relying on immediate previous-owner payments being recycled.
    await erc20.write.mint([alice.account.address, token("2000000000")]);
    await erc20.write.mint([bob.account.address, token("2000000000")]);
    await aliceToken.write.approve([vault.address, maxUint256]);
    await bobToken.write.approve([vault.address, maxUint256]);

    for (let cityId = 0; cityId < CITY_COUNT; cityId += 1) {
      await aliceVault.write.claimCity([cityId, FIRST_CLAIM_PRICE]);
    }
    assert.equal(BigInt(await vault.read.occupiedCityCount()), 56n);
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 112n);

    // Advance all cities round-by-round with no artificial time movement.
    for (let round = 0; round < CAPTURE_PAYMENTS.length; round += 1) {
      const captor = round % 2 === 0 ? bobVault : aliceVault;
      const payment = CAPTURE_PAYMENTS[round];
      const citiesThisRound = round === CAPTURE_PAYMENTS.length - 1
        ? CITY_COUNT - 1
        : CITY_COUNT;

      for (let cityId = 0; cityId < citiesThisRound; cityId += 1) {
        await captor.write.captureCity([
          cityId,
          payment,
          maxUint256,
          0n,
        ]);
      }
    }

    // City 55 is the real final upgrade: no harness or direct storage mutation.
    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 1n);
    assert.equal(BigInt(await vault.read.totalWeight()), 167n);
    assert.equal(await vault.read.compensationPoolClosed(), false);
    const penultimate = cityView(await vault.read.getCity([55]));
    assert.equal(penultimate.level, 2);
    assert.equal(penultimate.weight, 2);
    assert.equal(penultimate.capturesInCycle, 4);

    // At one remaining slot, the deterministic fair-share rule credits the
    // entire 30% pool to the final upgrading owner.
    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD,
    });
    assert.equal(await vault.read.compensationAvailable(), parseEther("30"));
    const indexBeforeFinal = BigInt(await vault.read.accDividendPerWeight());
    assert.equal(
      indexBeforeFinal,
      (parseEther("70") * PRECISION) / 167n,
    );

    const finalQuote = await vault.read.quoteCapture([55]);
    assert.equal(
      BigInt(finalQuote?.compensation ?? finalQuote?.[6]),
      parseEther("30"),
    );
    await aliceVault.write.captureCity([
      55,
      CAPTURE_PAYMENTS[9],
      maxUint256,
      parseEther("30"),
    ]);

    assert.equal(BigInt(await vault.read.remainingUpgradeSlots()), 0n);
    assert.equal(BigInt(await vault.read.totalWeight()), 168n);
    assert.equal(BigInt(await vault.read.occupiedCityCount()), 56n);
    assert.equal(await vault.read.compensationPoolClosed(), true);
    assert.equal(await vault.read.compensationAvailable(), 0n);
    assert.equal(
      await vault.read.claimableCompensation([alice.account.address]),
      parseEther("30"),
    );
    assert.equal(
      await vault.read.accDividendPerWeight(),
      indexBeforeFinal,
    );

    for (let cityId = 0; cityId < CITY_COUNT; cityId += 1) {
      const city = cityView(await vault.read.getCity([cityId]));
      assert.equal(city.level, 3);
      assert.equal(city.weight, 3);
      assert.equal(city.capturesInCycle, 0);
      assert.equal(city.anchorPrice, token("1680000"));
    }

    // Run a real terminal Lv.3 cycle for every city. The fifth capture caps the
    // reference anchor at 4,798,248 instead of resetting it to 1,680,000.
    for (let round = 0; round < LEVEL_THREE_CAPTURE_PAYMENTS.length; round += 1) {
      const captor = round % 2 === 0 ? bobVault : aliceVault;
      const payment = LEVEL_THREE_CAPTURE_PAYMENTS[round];

      for (let cityId = 0; cityId < CITY_COUNT; cityId += 1) {
        await captor.write.captureCity([
          cityId,
          payment,
          maxUint256,
          0n,
        ]);
      }
    }

    for (let cityId = 0; cityId < CITY_COUNT; cityId += 1) {
      const city = cityView(await vault.read.getCity([cityId]));
      assert.equal(city.level, 3);
      assert.equal(city.weight, 3);
      assert.equal(city.capturesInCycle, 0);
      assert.equal(city.anchorPrice, token("4798248"));
    }

    // Once closed, the next threshold receipt is routed 100% to dividends and
    // can never recreate a compensation balance.
    const indexAfterClosure = BigInt(await vault.read.accDividendPerWeight());
    await deployer.sendTransaction({
      to: vault.address,
      value: DISPATCH_THRESHOLD,
    });
    assert.equal(await vault.read.compensationAvailable(), 0n);
    assert.equal(await vault.read.undispatchedRevenue(), 0n);
    assert.equal(
      await vault.read.accDividendPerWeight(),
      indexAfterClosure + (DISPATCH_THRESHOLD * PRECISION) / 168n,
    );
  });
});
