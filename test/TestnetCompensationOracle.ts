import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther, zeroAddress } from "viem";

const connection = await network.create();
const { viem } = connection;

type LooseContract = any;

async function asWallet(
  address: `0x${string}`,
  wallet: Awaited<ReturnType<typeof viem.getWalletClients>>[number],
): Promise<LooseContract> {
  return viem.getContractAt("TestnetCompensationOracle", address, {
    client: { wallet },
  }) as Promise<LooseContract>;
}

describe("TestnetCompensationOracle", function () {
  it("rejects a zero operator", async function () {
    await assert.rejects(
      viem.deployContract("TestnetCompensationOracle", [zeroAddress]),
      /ZeroOperator/,
    );
  });

  it("starts invalid and lets only its immutable operator update the quote", async function () {
    const [operator, outsider] = await viem.getWalletClients();
    const oracle = (await viem.deployContract("TestnetCompensationOracle", [
      operator.account.address,
    ])) as LooseContract;

    assert.equal(
      (await oracle.read.operator()).toLowerCase(),
      operator.account.address.toLowerCase(),
    );
    assert.equal(await oracle.read.nativeQuote(), 0n);
    assert.equal(await oracle.read.valid(), false);
    assert.deepEqual(
      await oracle.read.quoteTokenToNative([zeroAddress, 123n]),
      [0n, false],
    );

    const outsiderOracle = await asWallet(oracle.address, outsider);
    await assert.rejects(
      outsiderOracle.write.setQuote([parseEther("1"), true]),
      /OnlyOperator/,
    );

    await oracle.write.setQuote([parseEther("0.25"), true]);
    assert.equal(await oracle.read.nativeQuote(), parseEther("0.25"));
    assert.equal(await oracle.read.valid(), true);
    assert.deepEqual(
      await oracle.read.quoteTokenToNative([zeroAddress, 999n]),
      [parseEther("0.25"), true],
    );
  });
});
