import { readFile } from "node:fs/promises";

import type { Address, Hex } from "viem";
import {
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isAddress,
  isHex,
  toBytes,
  zeroAddress,
  zeroHash,
} from "viem";

import type { LaunchParams } from "./flap-testnet-launch.js";

export const V2_ENVIRONMENT = "bsc-testnet-v2";
export const V2_DEPLOYER = getAddress(
  "0xa8eeeb1df159d93857faa6c861536ca641a40d69",
);
export const V2_TREASURY = getAddress(
  "0x2f60db58ef78455ba22e9ccad8e2a75b8564e149",
);
export const V2_TREASURY_KEY_REFERENCE =
  "SAFE_OWNER_B_TESTNET_ADDRESS";

export const V2_FLAP_PORTAL = getAddress(
  "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9",
);
export const V2_FLAP_VAULT_PORTAL = getAddress(
  "0x027e3704fC5C16522e9393d04C60A3ac5c0d775f",
);
export const V2_FLAP_TAX_V3_IMPLEMENTATION = getAddress(
  "0xE6Ff967a887084c16D0fD71548CF709542cc1557",
);

export const V2_TOKEN_NAME = "曜城纪 56 Testnet V2";
export const V2_TOKEN_SYMBOL = "YC56T2";
export const V2_TESTNET_WEBSITE = "http://43.165.188.147";
export const V2_TESTNET_METADATA_DESCRIPTION =
  "BSC Testnet-only V2 test token with no monetary value. Immediate city captures; 3% buy/sell tax routes 70% to weighted city distribution and 30% to capped upgrade compensation. Independent third-party experiment; not affiliated with or endorsed by Binance, BNB Chain, or Flap.";
export const V2_TOKEN_ICON_SHA256 =
  "2AB7438F6CFEDD718FF52D3F484EED16DD699805810334481D4E4CC97FA286FD";
export const V2_METADATA_UPLOAD_ACKNOWLEDGEMENT =
  "UPLOAD YC56T2 TESTNET METADATA ONCE";
export const V2_METADATA_CID =
  "bafkreicuuetvv6dtgekomgks4cyri46sjtnqf2c6kc723ugzgoxkornrse";
export const V2_METADATA_SOURCE_RECEIPT =
  "launch/bsc-testnet-v2-metadata-upload-receipt.json";

export const V2_BUY_TAX_BPS = 300;
export const V2_SELL_TAX_BPS = 300;
export const V2_MARKET_BPS = 10_000;
export const V2_TOKEN_VERSION = 6;
export const V2_MIGRATOR = 1;
export const V2_DEX_ID = 0;
export const V2_LP_FEE_PROFILE = 0;
export const V2_DISPATCH_THRESHOLD_WEI = 1_000_000_000_000_000n;
export const V2_CAPTURE_COOLDOWN_SECONDS = 0n;

export const V2_INFRA_BROADCAST_ACKNOWLEDGEMENT =
  "DEPLOY YC56T2 INFRA ON BSC TESTNET CHAIN 97";
export const V2_LAUNCH_BROADCAST_ACKNOWLEDGEMENT =
  "BROADCAST YC56T2 ON BSC TESTNET CHAIN 97";

export const V2_LAUNCH_CONFIG_URL = new URL(
  "../../launch/bsc-testnet-v2.json",
  import.meta.url,
);
export const V2_INFRA_MANIFEST_URL = new URL(
  "../../deployments/flap-bsc-testnet-v2-infra.json",
  import.meta.url,
);

export type V2LaunchPlan = {
  name: string;
  symbol: string;
  metaCid: string;
  treasury: Address;
  dispatchThreshold: bigint;
  captureCooldown: bigint;
  salt: Hex;
  predictedToken: Address;
  quoteAmt: bigint;
  dexThresh: number;
  taxDuration: bigint;
  antiFarmerDuration: bigint;
  infraBroadcastAcknowledged: boolean;
  launchBroadcastAcknowledged: boolean;
};

export type V2InfraContractRecord = {
  address: Address;
  transactionHash: Hex;
  runtimeBytecodeHash: Hex;
};

export type V2InfraManifest = {
  schemaVersion: number;
  environment: typeof V2_ENVIRONMENT;
  chainId: 97;
  testnetOnly: true;
  deployer: Address;
  treasury: Address;
  oracle: V2InfraContractRecord;
  factory: V2InfraContractRecord & { vaultDeployer: Address };
};

export class V2ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`BSC Testnet V2 configuration is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "V2ConfigurationError";
    this.issues = issues;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseAddress(
  value: unknown,
  field: string,
  issues: string[],
): Address | undefined {
  if (typeof value !== "string" || !isAddress(value)) {
    issues.push(`${field}: expected a valid address.`);
    return undefined;
  }
  return getAddress(value);
}

function parseHex32(
  value: unknown,
  field: string,
  issues: string[],
): Hex | undefined {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    value.length !== 66
  ) {
    issues.push(`${field}: expected a 32-byte 0x-prefixed hex value.`);
    return undefined;
  }
  return value;
}

function parseDecimalBigInt(
  value: unknown,
  field: string,
  issues: string[],
): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    issues.push(`${field}: expected a base-10 integer string.`);
    return undefined;
  }
  return BigInt(value);
}

function parseSafeInteger(
  value: unknown,
  field: string,
  issues: string[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.push(`${field}: expected a safe integer.`);
    return undefined;
  }
  return value;
}

export function parseV2LaunchConfig(raw: unknown): V2LaunchPlan {
  const issues: string[] = [];
  const config = asRecord(raw);
  if (config === undefined) {
    throw new V2ConfigurationError(["root: expected a JSON object."]);
  }

  if (config.schemaVersion !== 1) issues.push("schemaVersion: must be 1.");
  if (config.environment !== V2_ENVIRONMENT) {
    issues.push(`environment: must be ${V2_ENVIRONMENT}.`);
  }
  if (config.chainId !== 97 || config.testnetOnly !== true) {
    issues.push("chainId/testnetOnly: must be 97/true.");
  }
  if (config.name !== V2_TOKEN_NAME || config.symbol !== V2_TOKEN_SYMBOL) {
    issues.push(`name/symbol: must be ${V2_TOKEN_NAME}/${V2_TOKEN_SYMBOL}.`);
  }
  if (config.metaCid !== V2_METADATA_CID) {
    issues.push("metaCid: must match the reviewed reusable Flap metadata CID.");
  }
  const metadataReuse = asRecord(config.metadataReuse);
  if (metadataReuse?.sourceReceipt !== V2_METADATA_SOURCE_RECEIPT) {
    issues.push(
      `metadataReuse.sourceReceipt: must be ${V2_METADATA_SOURCE_RECEIPT}.`,
    );
  }
  if (config.treasuryKeyReference !== V2_TREASURY_KEY_REFERENCE) {
    issues.push(
      `treasuryKeyReference: must be ${V2_TREASURY_KEY_REFERENCE}.`,
    );
  }

  const treasury = parseAddress(config.treasury, "treasury", issues);
  if (treasury !== undefined && treasury !== V2_TREASURY) {
    issues.push(`treasury: must be the reviewed independent wallet ${V2_TREASURY}.`);
  }
  if (treasury !== undefined && treasury === V2_DEPLOYER) {
    issues.push("treasury: must not equal the creator/deployer.");
  }

  const dispatchThreshold = parseDecimalBigInt(
    config.dispatchThresholdWei,
    "dispatchThresholdWei",
    issues,
  );
  if (
    dispatchThreshold !== undefined &&
    dispatchThreshold !== V2_DISPATCH_THRESHOLD_WEI
  ) {
    issues.push(
      `dispatchThresholdWei: must be ${V2_DISPATCH_THRESHOLD_WEI}.`,
    );
  }

  const captureCooldown = parseSafeInteger(
    config.captureCooldownSeconds,
    "captureCooldownSeconds",
    issues,
  );
  if (
    captureCooldown !== undefined &&
    BigInt(captureCooldown) !== V2_CAPTURE_COOLDOWN_SECONDS
  ) {
    issues.push("captureCooldownSeconds: must be exactly 0.");
  }

  const salt = parseHex32(config.salt, "salt", issues);
  const predictedToken = parseAddress(
    config.predictedToken,
    "predictedToken",
    issues,
  );
  if (salt !== undefined) {
    const calculated = predictV2TokenAddress(salt);
    if (!calculated.toLowerCase().endsWith("7777")) {
      issues.push(`salt: predicts ${calculated}, which does not end in 7777.`);
    }
    if (
      predictedToken !== undefined &&
      calculated.toLowerCase() !== predictedToken.toLowerCase()
    ) {
      issues.push(`predictedToken: expected ${calculated} for the reviewed salt.`);
    }
  }

  const quoteAmt = parseDecimalBigInt(config.quoteAmtWei, "quoteAmtWei", issues);
  if (quoteAmt !== undefined && quoteAmt !== 0n) {
    issues.push("quoteAmtWei: must be 0 for the no-initial-buy launch.");
  }
  const dexThresh = parseSafeInteger(config.dexThresh, "dexThresh", issues);
  if (dexThresh !== undefined && dexThresh !== 1) {
    issues.push("dexThresh: must be 1 (FOUR_FIFTHS).");
  }
  const taxDuration = parseSafeInteger(
    config.taxDurationSeconds,
    "taxDurationSeconds",
    issues,
  );
  if (taxDuration !== undefined && taxDuration !== 3_153_600_000) {
    issues.push("taxDurationSeconds: must be 3153600000 (100 years).");
  }
  const antiFarmerDuration = parseSafeInteger(
    config.antiFarmerDurationSeconds,
    "antiFarmerDurationSeconds",
    issues,
  );
  if (antiFarmerDuration !== undefined && antiFarmerDuration !== 259_200) {
    issues.push("antiFarmerDurationSeconds: must be 259200 (3 days).");
  }

  if (issues.length !== 0) throw new V2ConfigurationError(issues);

  return {
    name: V2_TOKEN_NAME,
    symbol: V2_TOKEN_SYMBOL,
    metaCid: V2_METADATA_CID,
    treasury: treasury as Address,
    dispatchThreshold: dispatchThreshold as bigint,
    captureCooldown: BigInt(captureCooldown as number),
    salt: salt as Hex,
    predictedToken: predictedToken as Address,
    quoteAmt: quoteAmt as bigint,
    dexThresh: dexThresh as number,
    taxDuration: BigInt(taxDuration as number),
    antiFarmerDuration: BigInt(antiFarmerDuration as number),
    infraBroadcastAcknowledged:
      config.infraBroadcastAcknowledgement ===
      V2_INFRA_BROADCAST_ACKNOWLEDGEMENT,
    launchBroadcastAcknowledged:
      config.launchBroadcastAcknowledgement ===
      V2_LAUNCH_BROADCAST_ACKNOWLEDGEMENT,
  };
}

export async function loadV2LaunchConfig(): Promise<V2LaunchPlan> {
  return parseV2LaunchConfig(
    JSON.parse(await readFile(V2_LAUNCH_CONFIG_URL, "utf8")) as unknown,
  );
}

function parseInfraContract(
  raw: unknown,
  field: string,
  issues: string[],
): V2InfraContractRecord | undefined {
  const record = asRecord(raw);
  if (record === undefined) {
    issues.push(`${field}: expected an object.`);
    return undefined;
  }
  const address = parseAddress(record.address, `${field}.address`, issues);
  const transactionHash = parseHex32(
    record.transactionHash,
    `${field}.transactionHash`,
    issues,
  );
  const runtimeBytecodeHash = parseHex32(
    record.runtimeBytecodeHash,
    `${field}.runtimeBytecodeHash`,
    issues,
  );
  if (
    address === undefined ||
    transactionHash === undefined ||
    runtimeBytecodeHash === undefined
  ) {
    return undefined;
  }
  return { address, transactionHash, runtimeBytecodeHash };
}

export function parseV2InfraManifest(raw: unknown): V2InfraManifest {
  const issues: string[] = [];
  const record = asRecord(raw);
  if (record === undefined) {
    throw new V2ConfigurationError(["infra manifest: expected an object."]);
  }
  if (record.schemaVersion !== 1) issues.push("infra.schemaVersion: must be 1.");
  if (record.environment !== V2_ENVIRONMENT) {
    issues.push(`infra.environment: must be ${V2_ENVIRONMENT}.`);
  }
  if (record.chainId !== 97 || record.testnetOnly !== true) {
    issues.push("infra chainId/testnetOnly: must be 97/true.");
  }
  const deployer = parseAddress(record.deployer, "infra.deployer", issues);
  const treasury = parseAddress(record.treasury, "infra.treasury", issues);
  if (deployer !== undefined && deployer !== V2_DEPLOYER) {
    issues.push(`infra.deployer: must be ${V2_DEPLOYER}.`);
  }
  if (treasury !== undefined && treasury !== V2_TREASURY) {
    issues.push(`infra.treasury: must be ${V2_TREASURY}.`);
  }
  const oracle = parseInfraContract(record.oracle, "infra.oracle", issues);
  const factoryBase = parseInfraContract(record.factory, "infra.factory", issues);
  const factoryRecord = asRecord(record.factory);
  const vaultDeployer = parseAddress(
    factoryRecord?.vaultDeployer,
    "infra.factory.vaultDeployer",
    issues,
  );
  if (issues.length !== 0) throw new V2ConfigurationError(issues);
  return {
    schemaVersion: 1,
    environment: V2_ENVIRONMENT,
    chainId: 97,
    testnetOnly: true,
    deployer: deployer as Address,
    treasury: treasury as Address,
    oracle: oracle as V2InfraContractRecord,
    factory: {
      ...(factoryBase as V2InfraContractRecord),
      vaultDeployer: vaultDeployer as Address,
    },
  };
}

export async function loadV2InfraManifest(): Promise<V2InfraManifest> {
  return parseV2InfraManifest(
    JSON.parse(await readFile(V2_INFRA_MANIFEST_URL, "utf8")) as unknown,
  );
}

export function buildV2VaultData(
  plan: V2LaunchPlan,
  infra: V2InfraManifest,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address", name: "treasury" },
      { type: "address", name: "compensationOracle" },
      { type: "uint256", name: "dispatchThreshold" },
      { type: "uint256", name: "captureCooldown" },
    ],
    [
      plan.treasury,
      infra.oracle.address,
      plan.dispatchThreshold,
      plan.captureCooldown,
    ],
  );
}

export function buildV2LaunchParams(
  plan: V2LaunchPlan,
  infra: V2InfraManifest,
): LaunchParams {
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
    dexId: V2_DEX_ID,
    lpFeeProfile: V2_LP_FEE_PROFILE,
    buyTaxRate: V2_BUY_TAX_BPS,
    sellTaxRate: V2_SELL_TAX_BPS,
    taxDuration: plan.taxDuration,
    antiFarmerDuration: plan.antiFarmerDuration,
    mktBps: V2_MARKET_BPS,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
    dividendToken: zeroAddress,
    commissionReceiver: zeroAddress,
    tokenVersion: V2_TOKEN_VERSION,
    vaultFactory: infra.factory.address,
    vaultData: buildV2VaultData(plan, infra),
  };
}

export function buildV2NormalizedValidationData(): Hex {
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
        tokenVersion: V2_TOKEN_VERSION,
        quoteToken: zeroAddress,
        buyTaxRate: V2_BUY_TAX_BPS,
        sellTaxRate: V2_SELL_TAX_BPS,
        vaultBps: V2_MARKET_BPS,
        deflationBps: 0,
        dividendBps: 0,
        lpBps: 0,
        dividendToken: zeroAddress,
        minimumShareBalance: 0n,
      },
    ],
  );
}

export function predictV2TokenAddress(salt: Hex): Address {
  const minimalProxyBytecode = (
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    V2_FLAP_TAX_V3_IMPLEMENTATION.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3"
  ) as Hex;
  return getContractAddress({
    from: V2_FLAP_PORTAL,
    salt: toBytes(salt),
    bytecode: minimalProxyBytecode,
    opcode: "CREATE2",
  });
}
