import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAbiParameters, zeroAddress } from "viem";

import {
  BROADCAST_ACKNOWLEDGEMENT,
  CAPTURE_COOLDOWN_SECONDS,
  CITY_TESTNET_FACTORY,
  CITY_TESTNET_ORACLE,
  CITY_TESTNET_TREASURY,
  DISPATCH_THRESHOLD_WEI,
  TESTNET_METADATA_DESCRIPTION,
  TESTNET_WEBSITE,
  TOKEN_ICON_SHA256,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  LaunchConfigurationError,
  buildLaunchParams,
  parseLaunchConfig,
  predictTestnetTokenAddress,
} from "../scripts/lib/flap-testnet-launch.js";

const TEST_SALT =
  "0xe5f670a79c1fbb2907d2eaf7a5e5c86f715ac6e875dd02c5faef3905e9fee356";

function completeConfig() {
  return {
    environment: "bsc-testnet",
    chainId: 97,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    metaCid: "bafybeigdyrzt5exampletestcid",
    metadata: {
      imagePath: "public/token-icon-v1.png",
      imageSha256: TOKEN_ICON_SHA256,
      description: TESTNET_METADATA_DESCRIPTION,
      website: TESTNET_WEBSITE,
      twitter: null,
      telegram: null,
    },
    salt: TEST_SALT,
    quoteAmtWei: "0",
    dexThresh: 1,
    taxDurationSeconds: 3_153_600_000,
    antiFarmerDurationSeconds: 259_200,
    broadcastAcknowledgement: BROADCAST_ACKNOWLEDGEMENT,
  };
}

describe("BSC Testnet Flap launch plan", function () {
  it("locks the exact UTF-8 token name", function () {
    assert.deepEqual(
      Array.from(TOKEN_NAME, (character) => character.codePointAt(0)),
      [
        0x66dc, 0x57ce, 0x7eaa, 0x20, 0x35, 0x36, 0x20, 0x54, 0x65,
        0x73, 0x74, 0x6e, 0x65, 0x74,
      ],
    );
  });

  it("builds the exact reviewed V6 tax and vault parameters", function () {
    assert.equal(TOKEN_NAME, "曜城纪 56 Testnet");
    assert.equal(TOKEN_SYMBOL, "YC56T");
    const plan = parseLaunchConfig(completeConfig());
    const params = buildLaunchParams(plan);

    assert.equal(params.name, TOKEN_NAME);
    assert.equal(params.symbol, TOKEN_SYMBOL);
    assert.equal(params.dexThresh, 1);
    assert.equal(params.migratorType, 1);
    assert.equal(params.quoteToken, zeroAddress);
    assert.equal(params.quoteAmt, 0n);
    assert.equal(params.buyTaxRate, 300);
    assert.equal(params.sellTaxRate, 300);
    assert.equal(params.taxDuration, 3_153_600_000n);
    assert.equal(params.antiFarmerDuration, 259_200n);
    assert.equal(params.mktBps, 10_000);
    assert.equal(params.deflationBps, 0);
    assert.equal(params.dividendBps, 0);
    assert.equal(params.lpBps, 0);
    assert.equal(params.minimumShareBalance, 0n);
    assert.equal(params.dividendToken, zeroAddress);
    assert.equal(params.commissionReceiver, zeroAddress);
    assert.equal(params.tokenVersion, 6);
    assert.equal(params.vaultFactory, CITY_TESTNET_FACTORY);
    assert.equal(plan.broadcastAcknowledged, true);

    const decoded = decodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      params.vaultData,
    );
    assert.deepEqual(decoded, [
      CITY_TESTNET_TREASURY,
      CITY_TESTNET_ORACLE,
      DISPATCH_THRESHOLD_WEI,
      CAPTURE_COOLDOWN_SECONDS,
    ]);
  });

  it("predicts the reviewed testnet salt with Portal as CREATE2 deployer", function () {
    assert.equal(
      predictTestnetTokenAddress(TEST_SALT),
      "0x587b106de49cA4cC9e66D7a49819bb9a03377777",
    );
  });

  it("rejects drift from the three frozen launch timing/threshold choices", function () {
    const altered = completeConfig();
    altered.dexThresh = 0;
    altered.taxDurationSeconds = 31_536_000;
    altered.antiFarmerDurationSeconds = 86_400;

    assert.throws(
      () => parseLaunchConfig(altered),
      (error: unknown) => {
        assert.ok(error instanceof LaunchConfigurationError);
        assert.match(error.message, /dexThresh:.*fixed at 1/);
        assert.match(error.message, /taxDurationSeconds:.*3153600000/);
        assert.match(error.message, /antiFarmerDurationSeconds:.*259200/);
        return true;
      },
    );
  });

  it("fails closed on mainnet, missing CID, missing economic choices, or a launch buy", function () {
    const invalid = completeConfig();
    invalid.chainId = 56;
    invalid.environment = "bsc-mainnet";
    invalid.metaCid = "";
    invalid.dexThresh = null as unknown as number;
    invalid.taxDurationSeconds = null as unknown as number;
    invalid.antiFarmerDurationSeconds = null as unknown as number;
    invalid.quoteAmtWei = "1";

    assert.throws(
      () => parseLaunchConfig(invalid),
      (error: unknown) => {
        assert.ok(error instanceof LaunchConfigurationError);
        const message = error.message;
        assert.match(message, /chainId: must be exactly 97/);
        assert.match(message, /metaCid: upload/);
        assert.match(message, /dexThresh: choose/);
        assert.match(message, /taxDurationSeconds: choose/);
        assert.match(message, /antiFarmerDurationSeconds: choose/);
        assert.match(message, /quoteAmtWei:.*fixed at "0"/);
        return true;
      },
    );
  });
});
