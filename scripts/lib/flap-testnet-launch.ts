import { readFile } from "node:fs/promises";

import type { Address, Hex } from "viem";
import {
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isHex,
  keccak256,
  stringToHex,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";

export const FLAP_TESTNET_PORTAL = getAddress(
  "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9",
);
export const FLAP_TESTNET_VAULT_PORTAL = getAddress(
  "0x027e3704fC5C16522e9393d04C60A3ac5c0d775f",
);
export const FLAP_TESTNET_TAX_V3_IMPLEMENTATION = getAddress(
  "0xE6Ff967a887084c16D0fD71548CF709542cc1557",
);
export const CITY_TESTNET_FACTORY = getAddress(
  "0x7EE0FE25EB34a70FdF6d154b481aBe557F00Ce90",
);
export const CITY_TESTNET_ORACLE = getAddress(
  "0x6FBAaA5871406cEccC18F14eC754F7fb0A37D951",
);
export const CITY_TESTNET_DEPLOYER = getAddress(
  "0x1EA8679c2c287Ec20eFe42d3c8C0C02D1f92e862",
);
export const CITY_TESTNET_TREASURY = CITY_TESTNET_DEPLOYER;

export const EXPECTED_FACTORY_RUNTIME_HASH =
  "0x9d7da79399db9331c09a65858f895d13e7fb7078e2d494c2f3184bac60a5fc26" as Hex;
export const EXPECTED_ORACLE_RUNTIME_HASH =
  "0xe8b20d6ccdfd6a3f6e2d137265c63fbc481ab0a46cf9bc78a8b799c271e6a69a" as Hex;

export const TOKEN_NAME = "曜城纪 56 Testnet";
export const TOKEN_SYMBOL = "YC56T";
export const TESTNET_WEBSITE =
  "https://lumenhold-56.tart-basil-3815.chatgpt.site/";
export const TESTNET_METADATA_DESCRIPTION =
  "BSC Testnet-only test token with no monetary value. Independent third-party experiment; not affiliated with or endorsed by Binance, BNB Chain, or Flap.";
export const TOKEN_ICON_SHA256 =
  "2AB7438F6CFEDD718FF52D3F484EED16DD699805810334481D4E4CC97FA286FD";

export const BUY_TAX_BPS = 300;
export const SELL_TAX_BPS = 300;
export const MARKET_BPS = 10_000;
export const TOKEN_VERSION_TAXED_V3 = 6;
export const V2_MIGRATOR = 1;
export const DEX_ID_PANCAKE = 0;
export const LP_FEE_STANDARD = 0;
export const DISPATCH_THRESHOLD_WEI = 1_000_000_000_000_000n;
export const CAPTURE_COOLDOWN_SECONDS = 21_600n;

export const METADATA_UPLOAD_ACKNOWLEDGEMENT =
  "UPLOAD YC56T TESTNET METADATA ONCE";
export const BROADCAST_ACKNOWLEDGEMENT =
  "BROADCAST YC56T ON BSC TESTNET CHAIN 97";

export const LAUNCH_CONFIG_URL = new URL(
  "../../launch/bsc-testnet-flap-launch.json",
  import.meta.url,
);

export type LaunchPlan = {
  name: string;
  symbol: string;
  metaCid: string;
  salt: Hex;
  quoteAmt: bigint;
  dexThresh: number;
  taxDuration: bigint;
  antiFarmerDuration: bigint;
  broadcastAcknowledged: boolean;
};

export type LaunchParams = {
  name: string;
  symbol: string;
  meta: string;
  dexThresh: number;
  salt: Hex;
  migratorType: number;
  quoteToken: Address;
  quoteAmt: bigint;
  permitData: Hex;
  extensionID: Hex;
  extensionData: Hex;
  dexId: number;
  lpFeeProfile: number;
  buyTaxRate: number;
  sellTaxRate: number;
  taxDuration: bigint;
  antiFarmerDuration: bigint;
  mktBps: number;
  deflationBps: number;
  dividendBps: number;
  lpBps: number;
  minimumShareBalance: bigint;
  dividendToken: Address;
  commissionReceiver: Address;
  tokenVersion: number;
  vaultFactory: Address;
  vaultData: Hex;
};

export class LaunchConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`BSC Testnet launch configuration is incomplete:\n- ${issues.join("\n- ")}`);
    this.name = "LaunchConfigurationError";
    this.issues = issues;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseInteger(
  value: unknown,
  field: string,
  issues: string[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.push(`${field}: choose and record an integer value.`);
    return undefined;
  }
  return value;
}

function parseWeiString(
  value: unknown,
  field: string,
  issues: string[],
): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    issues.push(
      `${field}: record the explicit native-BNB launch-buy amount in wei; use \"0\" to skip the launch buy.`,
    );
    return undefined;
  }
  return BigInt(value);
}

export function parseLaunchConfig(raw: unknown): LaunchPlan {
  const issues: string[] = [];
  const config = asRecord(raw);
  if (config === undefined) {
    throw new LaunchConfigurationError(["root: expected a JSON object."]);
  }

  if (config.environment !== "bsc-testnet") {
    issues.push("environment: must be exactly bsc-testnet.");
  }
  if (config.chainId !== 97) {
    issues.push("chainId: must be exactly 97.");
  }
  if (config.name !== TOKEN_NAME) {
    issues.push(`name: must remain the reviewed test placeholder ${TOKEN_NAME}.`);
  }
  if (config.symbol !== TOKEN_SYMBOL) {
    issues.push(`symbol: must remain the reviewed test placeholder ${TOKEN_SYMBOL}.`);
  }

  const metadata = asRecord(config.metadata);
  if (metadata === undefined) {
    issues.push("metadata: expected the reviewed metadata object.");
  } else {
    if (metadata.imagePath !== "public/token-icon-v1.png") {
      issues.push("metadata.imagePath: must be public/token-icon-v1.png.");
    }
    if (metadata.imageSha256 !== TOKEN_ICON_SHA256) {
      issues.push("metadata.imageSha256: does not match the reviewed icon.");
    }
    if (metadata.description !== TESTNET_METADATA_DESCRIPTION) {
      issues.push("metadata.description: must retain the TESTNET/no-value/independent disclaimer.");
    }
    if (metadata.website !== TESTNET_WEBSITE) {
      issues.push(`metadata.website: must be ${TESTNET_WEBSITE}.`);
    }
    if (metadata.twitter !== null || metadata.telegram !== null) {
      issues.push("metadata social fields: keep twitter and telegram null until real project accounts exist.");
    }
  }

  const metaCid = config.metaCid;
  if (typeof metaCid !== "string" || metaCid.trim() === "") {
    issues.push(
      "metaCid: upload public/token-icon-v1.png with the explicit metadata command, then paste the returned Flap IPFS CID here.",
    );
  } else if (
    metaCid !== metaCid.trim() ||
    metaCid.startsWith("ipfs://") ||
    /\s/.test(metaCid)
  ) {
    issues.push("metaCid: use the raw Flap-returned CID with no ipfs:// prefix or whitespace.");
  }

  const saltValue = config.salt;
  let salt: Hex | undefined;
  if (
    typeof saltValue !== "string" ||
    !isHex(saltValue, { strict: true }) ||
    saltValue.length !== 66
  ) {
    issues.push(
      "salt: run npm run flap:testnet:mine-salt and paste the displayed bytes32 salt here.",
    );
  } else {
    salt = saltValue;
    const predicted = predictTestnetTokenAddress(salt);
    if (!predicted.toLowerCase().endsWith("7777")) {
      issues.push(`salt: predicts ${predicted}, which does not end in 7777.`);
    }
  }

  const quoteAmt = parseWeiString(config.quoteAmtWei, "quoteAmtWei", issues);
  if (quoteAmt !== undefined && quoteAmt !== 0n) {
    issues.push("quoteAmtWei: this reviewed no-initial-buy test launch is fixed at \"0\".");
  }
  const dexThresh = parseInteger(config.dexThresh, "dexThresh", issues);
  if (dexThresh !== undefined && (dexThresh < 0 || dexThresh > 5)) {
    issues.push("dexThresh: must be a valid DexThreshType enum value from 0 through 5.");
  } else if (dexThresh !== undefined && dexThresh !== 1) {
    issues.push("dexThresh: this reviewed testnet launch is fixed at 1 (FOUR_FIFTHS).");
  }

  const taxDurationNumber = parseInteger(
    config.taxDurationSeconds,
    "taxDurationSeconds",
    issues,
  );
  if (
    taxDurationNumber !== undefined &&
    (taxDurationNumber < 31_536_000 || taxDurationNumber > 3_153_600_000)
  ) {
    issues.push("taxDurationSeconds: Flap requires 365 days through 100 years.");
  } else if (
    taxDurationNumber !== undefined &&
    taxDurationNumber !== 3_153_600_000
  ) {
    issues.push("taxDurationSeconds: this reviewed testnet launch is fixed at 3153600000 (100*365 days).");
  }

  const antiFarmerNumber = parseInteger(
    config.antiFarmerDurationSeconds,
    "antiFarmerDurationSeconds",
    issues,
  );
  if (
    antiFarmerNumber !== undefined &&
    (antiFarmerNumber < 86_400 || antiFarmerNumber > 31_536_000)
  ) {
    issues.push("antiFarmerDurationSeconds: Flap requires 1 day through 1 year.");
  } else if (antiFarmerNumber !== undefined && antiFarmerNumber !== 259_200) {
    issues.push("antiFarmerDurationSeconds: this reviewed testnet launch is fixed at 259200 (3 days).");
  }

  if (issues.length !== 0) {
    throw new LaunchConfigurationError(issues);
  }

  return {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    metaCid: metaCid as string,
    salt: salt as Hex,
    quoteAmt: quoteAmt as bigint,
    dexThresh: dexThresh as number,
    taxDuration: BigInt(taxDurationNumber as number),
    antiFarmerDuration: BigInt(antiFarmerNumber as number),
    broadcastAcknowledged:
      config.broadcastAcknowledgement === BROADCAST_ACKNOWLEDGEMENT,
  };
}

export async function loadLaunchConfig(): Promise<{
  raw: Record<string, unknown>;
  plan: LaunchPlan;
}> {
  const raw = JSON.parse(await readFile(LAUNCH_CONFIG_URL, "utf8")) as unknown;
  const record = asRecord(raw);
  if (record === undefined) {
    throw new LaunchConfigurationError(["root: expected a JSON object."]);
  }
  return { raw: record, plan: parseLaunchConfig(record) };
}

export function buildVaultData(): Hex {
  return encodeAbiParameters(
    [
      { type: "address", name: "treasury" },
      { type: "address", name: "compensationOracle" },
      { type: "uint256", name: "dispatchThreshold" },
      { type: "uint256", name: "captureCooldown" },
    ],
    [
      CITY_TESTNET_TREASURY,
      CITY_TESTNET_ORACLE,
      DISPATCH_THRESHOLD_WEI,
      CAPTURE_COOLDOWN_SECONDS,
    ],
  );
}

export function buildLaunchParams(plan: LaunchPlan): LaunchParams {
  return {
    name: plan.name,
    symbol: plan.symbol,
    meta: plan.metaCid,
    dexThresh: plan.dexThresh,
    salt: plan.salt,
    migratorType: V2_MIGRATOR,
    quoteToken: zeroAddress,
    quoteAmt: plan.quoteAmt,
    permitData: "0x",
    extensionID: zeroHash,
    extensionData: "0x",
    dexId: DEX_ID_PANCAKE,
    lpFeeProfile: LP_FEE_STANDARD,
    buyTaxRate: BUY_TAX_BPS,
    sellTaxRate: SELL_TAX_BPS,
    taxDuration: plan.taxDuration,
    antiFarmerDuration: plan.antiFarmerDuration,
    mktBps: MARKET_BPS,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
    dividendToken: zeroAddress,
    commissionReceiver: zeroAddress,
    tokenVersion: TOKEN_VERSION_TAXED_V3,
    vaultFactory: CITY_TESTNET_FACTORY,
    vaultData: buildVaultData(),
  };
}

export function buildNormalizedValidationData(): Hex {
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
        tokenVersion: TOKEN_VERSION_TAXED_V3,
        quoteToken: zeroAddress,
        buyTaxRate: BUY_TAX_BPS,
        sellTaxRate: SELL_TAX_BPS,
        vaultBps: MARKET_BPS,
        deflationBps: 0,
        dividendBps: 0,
        lpBps: 0,
        dividendToken: zeroAddress,
        minimumShareBalance: 0n,
      },
    ],
  );
}

export function predictTestnetTokenAddress(salt: Hex): Address {
  const minimalProxyBytecode = (
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    FLAP_TESTNET_TAX_V3_IMPLEMENTATION.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3"
  ) as Hex;

  return getContractAddress({
    from: FLAP_TESTNET_PORTAL,
    salt: toBytes(salt),
    bytecode: minimalProxyBytecode,
    opcode: "CREATE2",
  });
}

export function mineTestnetVanitySalt(
  publicSeed: string,
  maxIterations = 1_000_000,
): { salt: Hex; predictedToken: Address; iterations: number } {
  if (publicSeed.trim() === "") {
    throw new Error("saltSearchSeed must be a non-empty public string.");
  }
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error("maxIterations must be a positive safe integer.");
  }

  let salt = keccak256(stringToHex(publicSeed));
  for (let iterations = 0; iterations < maxIterations; iterations += 1) {
    const predictedToken = predictTestnetTokenAddress(salt);
    if (predictedToken.toLowerCase().endsWith("7777")) {
      return { salt, predictedToken, iterations };
    }
    salt = keccak256(salt);
  }

  throw new Error(`No 7777 salt found within ${maxIterations} iterations.`);
}
