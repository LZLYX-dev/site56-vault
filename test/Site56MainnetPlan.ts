import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAbiParameters, getAddress, zeroAddress } from "viem";

import {
  SITE56_ANTI_FARMER_DURATION_SECONDS,
  SITE56_BUY_TAX_BPS,
  SITE56_DISPATCH_THRESHOLD_WEI,
  SITE56_FIRST_CLAIM_TREASURY,
  SITE56_GITHUB,
  SITE56_INITIAL_BUY_QUOTE_WEI,
  SITE56_LAUNCH_CREATOR,
  SITE56_NAME,
  SITE56_SELL_TAX_BPS,
  SITE56_SYMBOL,
  SITE56_TAX_DURATION_SECONDS,
  SITE56_TWITTER,
  buildSite56LaunchParams,
  mineSite56VanitySalt,
  predictSite56TokenAddress,
} from "../scripts/lib/site56-mainnet.js";

const FACTORY = getAddress("0x0000000000000000000000000000000000000056");

describe("Site 56 immutable mainnet launch plan", function () {
  it("encodes the formal identity, 3/3 tax and 0.5 BNB initial-buy parameters", function () {
    const mined = mineSite56VanitySalt("site56-mainnet-plan-unit-test");
    const params = buildSite56LaunchParams({
      metadataCid: "bafy-site56-reviewed-cid-placeholder",
      salt: mined.salt,
      vaultFactory: FACTORY,
    });

    assert.equal(params.name, SITE56_NAME);
    assert.equal(params.symbol, SITE56_SYMBOL);
    assert.equal(
      SITE56_LAUNCH_CREATOR,
      getAddress("0xFbf4a9E11C1Af4ACd29e39fec4fccF8ee4ed2128"),
    );
    assert.equal(SITE56_TWITTER, "https://x.com/Site56_City");
    assert.equal(SITE56_GITHUB, "https://github.com/LZLYX-dev/site56-vault");
    assert.equal(params.buyTaxRate, SITE56_BUY_TAX_BPS);
    assert.equal(params.sellTaxRate, SITE56_SELL_TAX_BPS);
    assert.equal(params.taxDuration, SITE56_TAX_DURATION_SECONDS);
    assert.equal(params.antiFarmerDuration, SITE56_ANTI_FARMER_DURATION_SECONDS);
    assert.equal(params.mktBps, 10_000);
    assert.equal(params.quoteToken, zeroAddress);
    assert.equal(params.quoteAmt, SITE56_INITIAL_BUY_QUOTE_WEI);
    assert.equal(params.vaultFactory, FACTORY);
    assert.equal(predictSite56TokenAddress(mined.salt), mined.predictedToken);
    assert.match(mined.predictedToken, /7777$/i);
  });

  it("encodes only treasury, threshold and zero cooldown in vaultData", function () {
    const mined = mineSite56VanitySalt("site56-mainnet-vault-data-unit-test");
    const params = buildSite56LaunchParams({
      metadataCid: "bafy-site56-reviewed-cid-placeholder",
      salt: mined.salt,
      vaultFactory: FACTORY,
    });
    const decoded = decodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      params.vaultData,
    );
    assert.deepEqual(decoded, [
      SITE56_FIRST_CLAIM_TREASURY,
      SITE56_DISPATCH_THRESHOLD_WEI,
      0n,
    ]);
  });

  it("rejects empty, prefixed, or whitespace-padded metadata identifiers", function () {
    const mined = mineSite56VanitySalt("site56-mainnet-cid-unit-test");
    for (const metadataCid of ["", " ipfs-cid", "ipfs-cid ", "ipfs://cid"]) {
      assert.throws(() =>
        buildSite56LaunchParams({
          metadataCid,
          salt: mined.salt,
          vaultFactory: FACTORY,
        }),
      );
    }
  });
});
