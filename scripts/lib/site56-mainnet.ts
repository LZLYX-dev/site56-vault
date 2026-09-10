import type { Address, Hex } from "viem";
import {
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  stringToHex,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";

import type { LaunchParams } from "./flap-testnet-launch.js";

export const SITE56_NAME = "Site 56";
export const SITE56_SYMBOL = "SITE56";
export const SITE56_WEBSITE = "https://site56.city";
export const SITE56_METADATA_DESCRIPTION =
  "Site 56 is an independent BNB Smart Chain meme city game: claim, capture and build 56 on-chain cities together. A 3% buy/sell tax routes 70% to city-weighted BNB distributions and 30% to deterministic upgrade compensation. Not affiliated with or endorsed by Binance, BNB Chain or Flap.";
export const SITE56_IMAGE_SHA256 =
  "A95FFA54BE4B47E500217FB8B1388546335B2F8E4509AFEC98FBB1408EDD18DC";

export const BSC_MAINNET_CHAIN_ID = 56;
export const FLAP_MAINNET_PORTAL = getAddress(
  "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
);
export const FLAP_MAINNET_VAULT_PORTAL = getAddress(
  "0x90497450f2a706f1951b5bdda52B4E5d16f34C06",
);
export const FLAP_MAINNET_TAX_V3_IMPLEMENTATION = getAddress(
  "0x024f18294970B5c76c0691b87f138A0317156422",
);
export const SITE56_LAUNCH_CREATOR = getAddress(
  "0xFbf4a9E11C1Af4ACd29e39fec4fccF8ee4ed2128",
);
export const SITE56_FIRST_CLAIM_TREASURY = getAddress(
  "0xE4334Db796a110871604E464A03dbBADcADB9dc8",
);
export const SITE56_GOVERNANCE_SAFE = getAddress(
  "0xE4334Db796a110871604E464A03dbBADcADB9dc8",
);

export const SITE56_BUY_TAX_BPS = 300;
export const SITE56_SELL_TAX_BPS = 300;
export const SITE56_MARKET_BPS = 10_000;
export const SITE56_TOKEN_VERSION = 6;
export const SITE56_MIGRATOR = 1;
export const SITE56_DEX_THRESHOLD = 1;
export const SITE56_DEX_ID = 0;
export const SITE56_LP_FEE_PROFILE = 0;
export const SITE56_TAX_DURATION_SECONDS = 3_153_600_000n;
export const SITE56_ANTI_FARMER_DURATION_SECONDS = 259_200n;
export const SITE56_DISPATCH_THRESHOLD_WEI = 10_000_000_000_000_000n;
export const SITE56_CAPTURE_COOLDOWN_SECONDS = 0n;
export const SITE56_COMPENSATION_MODEL =
  "remaining-pool-over-remaining-upgrade-slots-v1";

export type Site56LaunchInput = {
  metadataCid: string;
  salt: Hex;
  vaultFactory: Address;
  treasury?: Address;
  dexThreshold?: number;
  dispatchThreshold?: bigint;
};

export function buildSite56VaultData(
  treasury: Address = SITE56_FIRST_CLAIM_TREASURY,
  dispatchThreshold = SITE56_DISPATCH_THRESHOLD_WEI,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address", name: "treasury" },
      { type: "uint256", name: "dispatchThreshold" },
      { type: "uint256", name: "captureCooldown" },
    ],
    [treasury, dispatchThreshold, SITE56_CAPTURE_COOLDOWN_SECONDS],
  );
}

export function buildSite56LaunchParams(input: Site56LaunchInput): LaunchParams {
  if (input.metadataCid.trim() === "" || input.metadataCid !== input.metadataCid.trim()) {
    throw new Error("metadataCid must be a non-empty raw CID without surrounding whitespace.");
  }
  if (input.metadataCid.startsWith("ipfs://")) {
    throw new Error("metadataCid must be the raw Flap CID without an ipfs:// prefix.");
  }

  return {
    name: SITE56_NAME,
    symbol: SITE56_SYMBOL,
    meta: input.metadataCid,
    dexThresh: input.dexThreshold ?? SITE56_DEX_THRESHOLD,
    salt: input.salt,
    migratorType: SITE56_MIGRATOR,
    quoteToken: zeroAddress,
    quoteAmt: 0n,
    permitData: "0x",
    extensionID: zeroHash,
    extensionData: "0x",
    dexId: SITE56_DEX_ID,
    lpFeeProfile: SITE56_LP_FEE_PROFILE,
    buyTaxRate: SITE56_BUY_TAX_BPS,
    sellTaxRate: SITE56_SELL_TAX_BPS,
    taxDuration: SITE56_TAX_DURATION_SECONDS,
    antiFarmerDuration: SITE56_ANTI_FARMER_DURATION_SECONDS,
    mktBps: SITE56_MARKET_BPS,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
    dividendToken: zeroAddress,
    commissionReceiver: zeroAddress,
    tokenVersion: SITE56_TOKEN_VERSION,
    vaultFactory: getAddress(input.vaultFactory),
    vaultData: buildSite56VaultData(
      input.treasury ?? SITE56_FIRST_CLAIM_TREASURY,
      input.dispatchThreshold ?? SITE56_DISPATCH_THRESHOLD_WEI,
    ),
  };
}

export function buildSite56NormalizedValidationData(): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "tokenVersion", type: "uint8" },
          { name: "quoteToken", type: "address" },
          { name: "buyTaxRate", type: "uint16" },
          { name: "sellTaxRate", type: "uint16" },
          { name: "vaultBps", type: "uint16" },
          { name: "deflationBps", type: "uint16" },
          { name: "dividendBps", type: "uint16" },
          { name: "lpBps", type: "uint16" },
          { name: "dividendToken", type: "address" },
          { name: "minimumShareBalance", type: "uint256" },
        ],
      },
    ],
    [
      {
        tokenVersion: SITE56_TOKEN_VERSION,
        quoteToken: zeroAddress,
        buyTaxRate: SITE56_BUY_TAX_BPS,
        sellTaxRate: SITE56_SELL_TAX_BPS,
        vaultBps: SITE56_MARKET_BPS,
        deflationBps: 0,
        dividendBps: 0,
        lpBps: 0,
        dividendToken: zeroAddress,
        minimumShareBalance: 0n,
      },
    ],
  );
}

export function predictSite56TokenAddress(salt: Hex): Address {
  const minimalProxyBytecode = (
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    FLAP_MAINNET_TAX_V3_IMPLEMENTATION.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3"
  ) as Hex;

  return getContractAddress({
    from: FLAP_MAINNET_PORTAL,
    salt: toBytes(salt),
    bytecode: minimalProxyBytecode,
    opcode: "CREATE2",
  });
}

export function mineSite56VanitySalt(
  publicSeed: string,
  maxIterations = 1_000_000,
): { salt: Hex; predictedToken: Address; iterations: number } {
  if (publicSeed.trim() === "") throw new Error("publicSeed must not be empty.");
  let salt = keccak256(stringToHex(publicSeed));
  for (let iterations = 0; iterations < maxIterations; iterations += 1) {
    const predictedToken = predictSite56TokenAddress(salt);
    if (predictedToken.toLowerCase().endsWith("7777")) {
      return { salt, predictedToken, iterations };
    }
    salt = keccak256(salt);
  }
  throw new Error(`No 7777 salt found within ${maxIterations} iterations.`);
}
