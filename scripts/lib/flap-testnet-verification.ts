import { artifacts } from "hardhat";
import type { Address, Hex } from "viem";
import {
  decodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  zeroAddress,
} from "viem";

import type { openBscTestnetContext } from "./bsc-testnet.js";
import {
  BSC_TESTNET_CHAIN_ID,
  addressExplorerUrl,
  transactionExplorerUrl,
} from "./bsc-testnet.js";
import type { LaunchParams } from "./flap-testnet-launch.js";
import {
  BUY_TAX_BPS,
  CAPTURE_COOLDOWN_SECONDS,
  CITY_TESTNET_DEPLOYER,
  CITY_TESTNET_FACTORY,
  CITY_TESTNET_ORACLE,
  CITY_TESTNET_TREASURY,
  DISPATCH_THRESHOLD_WEI,
  FLAP_TESTNET_PORTAL,
  FLAP_TESTNET_TAX_V3_IMPLEMENTATION,
  FLAP_TESTNET_VAULT_PORTAL,
  LP_FEE_STANDARD,
  SELL_TAX_BPS,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_VERSION_TAXED_V3,
  predictTestnetTokenAddress,
} from "./flap-testnet-launch.js";

type TestnetContext = Awaited<ReturnType<typeof openBscTestnetContext>>;

export const FLAP_TESTNET_LAUNCH_TRANSACTION =
  "0xb66d6228f744134f3f90fd5d89fd2da9fcaaf5286009819373b5a48aa5f8c6aa" as Hex;
export const FLAP_TESTNET_REQUIRED_CONFIRMATIONS = 3;

const ERC20_METADATA_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

export type FlapTestnetLaunchVerification = {
  transactionHash: Hex;
  transactionBlockNumber: bigint;
  transactionBlockHash: Hex;
  transactionBlockTimestamp: bigint;
  confirmations: bigint;
  token: Address;
  tokenCode: Hex;
  tokenRuntimeHash: Hex;
  vault: Address;
  vaultCode: Hex;
  vaultRuntimeHash: Hex;
  tokenName: string;
  tokenSymbol: string;
  vaultDescription: string;
  vaultOfficial: boolean;
  vaultRiskLevel: number;
  portalTokenStatus: number;
  portalTokenVersion: number;
  portalBuyTaxBps: bigint;
  portalSellTaxBps: bigint;
};

function tupleField<T>(value: unknown, name: string, index: number): T {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  return (record?.[name] ?? (value as readonly unknown[])?.[index]) as T;
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not a valid address.`);
  }
  return value;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw new Error(`${label} is not an integer.`);
  }
  return BigInt(value);
}

function assertAddress(actual: unknown, expected: Address, label: string): void {
  const address = requireAddress(actual, label);
  if (address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} is ${address}, expected ${expected}.`);
  }
}

function assertInputMatches(paramsRaw: unknown, expected: LaunchParams): void {
  const stringFields = [
    ["name", 0, expected.name],
    ["symbol", 1, expected.symbol],
    ["meta", 2, expected.meta],
  ] as const;
  for (const [name, index, expectedValue] of stringFields) {
    const actual = tupleField<unknown>(paramsRaw, name, index);
    if (actual !== expectedValue) {
      throw new Error(`Transaction launch parameter ${name} does not match the reviewed plan.`);
    }
  }

  const hexFields = [
    ["salt", 4, expected.salt],
    ["permitData", 8, expected.permitData],
    ["extensionID", 9, expected.extensionID],
    ["extensionData", 10, expected.extensionData],
    ["vaultData", 26, expected.vaultData],
  ] as const;
  for (const [name, index, expectedValue] of hexFields) {
    const actual = tupleField<unknown>(paramsRaw, name, index);
    if (
      typeof actual !== "string" ||
      actual.toLowerCase() !== expectedValue.toLowerCase()
    ) {
      throw new Error(`Transaction launch parameter ${name} does not match the reviewed plan.`);
    }
  }

  const addressFields = [
    ["quoteToken", 6, expected.quoteToken],
    ["dividendToken", 22, expected.dividendToken],
    ["commissionReceiver", 23, expected.commissionReceiver],
    ["vaultFactory", 25, expected.vaultFactory],
  ] as const;
  for (const [name, index, expectedValue] of addressFields) {
    assertAddress(
      tupleField(paramsRaw, name, index),
      expectedValue,
      `Transaction launch parameter ${name}`,
    );
  }

  const integerFields = [
    ["dexThresh", 3, BigInt(expected.dexThresh)],
    ["migratorType", 5, BigInt(expected.migratorType)],
    ["quoteAmt", 7, expected.quoteAmt],
    ["dexId", 11, BigInt(expected.dexId)],
    ["lpFeeProfile", 12, BigInt(expected.lpFeeProfile)],
    ["buyTaxRate", 13, BigInt(expected.buyTaxRate)],
    ["sellTaxRate", 14, BigInt(expected.sellTaxRate)],
    ["taxDuration", 15, expected.taxDuration],
    ["antiFarmerDuration", 16, expected.antiFarmerDuration],
    ["mktBps", 17, BigInt(expected.mktBps)],
    ["deflationBps", 18, BigInt(expected.deflationBps)],
    ["dividendBps", 19, BigInt(expected.dividendBps)],
    ["lpBps", 20, BigInt(expected.lpBps)],
    ["minimumShareBalance", 21, expected.minimumShareBalance],
    ["tokenVersion", 24, BigInt(expected.tokenVersion)],
  ] as const;
  for (const [name, index, expectedValue] of integerFields) {
    const actual = asBigInt(
      tupleField(paramsRaw, name, index),
      `Transaction launch parameter ${name}`,
    );
    if (actual !== expectedValue) {
      throw new Error(
        `Transaction launch parameter ${name} is ${actual}, expected ${expectedValue}.`,
      );
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryRead<T>(
  label: string,
  read: () => Promise<T>,
  attempts = 8,
  delayMilliseconds = 1_500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt !== attempts) {
        console.log(`${label} not ready (attempt ${attempt}/${attempts}); retrying.`);
        await delay(delayMilliseconds);
      }
    }
  }
  throw new Error(`${label} remained unavailable after ${attempts} attempts.`, {
    cause: lastError,
  });
}

async function requireRuntimeCodeWithRetry(
  context: TestnetContext,
  label: string,
  address: Address,
): Promise<Hex> {
  return retryRead(label, async () => {
    const code = await context.publicClient.getCode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(`${label} has no runtime code at ${address}.`);
    }
    return code;
  });
}

function expectedTaxV3ProxyRuntime(): Hex {
  return (
    "0x363d3d373d3d3d363d73" +
    FLAP_TESTNET_TAX_V3_IMPLEMENTATION.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3"
  ) as Hex;
}

export async function verifyExistingFlapTestnetLaunch(
  context: TestnetContext,
  transactionHash: Hex,
  expectedParams: LaunchParams,
): Promise<FlapTestnetLaunchVerification> {
  const chainId = await context.publicClient.getChainId();
  if (chainId !== BSC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing Flap verification: RPC returned chainId ${chainId}, expected ${BSC_TESTNET_CHAIN_ID}.`,
    );
  }

  const [vaultPortalArtifact, factoryArtifact, cityVaultArtifact, portalArtifact] =
    await Promise.all([
      artifacts.readArtifact("IVaultPortal"),
      artifacts.readArtifact("CityVaultFactory"),
      artifacts.readArtifact("CityVault"),
      artifacts.readArtifact("IPortal"),
    ]);

  const receipt = await context.publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: FLAP_TESTNET_REQUIRED_CONFIRMATIONS,
    timeout: 60_000,
    pollingInterval: 1_500,
  });
  if (receipt.status !== "success") {
    throw new Error(`Flap launch transaction did not succeed: ${transactionHash}.`);
  }
  assertAddress(receipt.from, CITY_TESTNET_DEPLOYER, "Transaction sender");
  assertAddress(receipt.to, FLAP_TESTNET_VAULT_PORTAL, "Transaction recipient");

  const transaction = await context.publicClient.getTransaction({
    hash: transactionHash,
  });
  if (transaction.value !== 0n) {
    throw new Error(`Launch transaction value is ${transaction.value}, expected 0.`);
  }
  const decoded = decodeFunctionData({
    abi: vaultPortalArtifact.abi,
    data: transaction.input,
  });
  if (decoded.functionName !== "newTokenV6WithVault") {
    throw new Error(`Unexpected VaultPortal function ${decoded.functionName}.`);
  }
  const paramsRaw = (decoded.args as readonly unknown[] | undefined)?.[0];
  if (paramsRaw === undefined) {
    throw new Error("Launch transaction has no parameter tuple.");
  }
  assertInputMatches(paramsRaw, expectedParams);

  const vaultPortalEvents = parseEventLogs({
    abi: vaultPortalArtifact.abi,
    logs: receipt.logs,
    eventName: "FlapTaxVaultTokenCreated",
    strict: true,
  }).filter(
    (event) =>
      event.address.toLowerCase() === FLAP_TESTNET_VAULT_PORTAL.toLowerCase(),
  );
  const factoryEvents = parseEventLogs({
    abi: factoryArtifact.abi,
    logs: receipt.logs,
    eventName: "CityVaultCreated",
    strict: true,
  }).filter(
    (event) => event.address.toLowerCase() === CITY_TESTNET_FACTORY.toLowerCase(),
  );
  if (vaultPortalEvents.length !== 1 || factoryEvents.length !== 1) {
    throw new Error(
      `Expected one creation event from each reviewed emitter; found ${vaultPortalEvents.length} and ${factoryEvents.length}.`,
    );
  }

  const portalArgs = vaultPortalEvents[0].args;
  const token = requireAddress(
    tupleField(portalArgs, "token", 0),
    "FlapTaxVaultTokenCreated token",
  );
  const vault = requireAddress(
    tupleField(portalArgs, "vault", 1),
    "FlapTaxVaultTokenCreated vault",
  );
  assertAddress(
    tupleField(portalArgs, "vaultFactory", 2),
    CITY_TESTNET_FACTORY,
    "FlapTaxVaultTokenCreated factory",
  );
  const predictedToken = predictTestnetTokenAddress(expectedParams.salt);
  assertAddress(token, predictedToken, "Created token");

  const factoryArgs = factoryEvents[0].args;
  assertAddress(tupleField(factoryArgs, "vault", 0), vault, "CityVaultCreated vault");
  assertAddress(tupleField(factoryArgs, "taxToken", 1), token, "CityVaultCreated token");
  assertAddress(
    tupleField(factoryArgs, "creator", 2),
    CITY_TESTNET_DEPLOYER,
    "CityVaultCreated creator",
  );
  assertAddress(
    tupleField(factoryArgs, "treasury", 3),
    CITY_TESTNET_TREASURY,
    "CityVaultCreated treasury",
  );
  assertAddress(
    tupleField(factoryArgs, "compensationOracle", 4),
    CITY_TESTNET_ORACLE,
    "CityVaultCreated oracle",
  );
  if (
    asBigInt(tupleField(factoryArgs, "dispatchThreshold", 5), "Event threshold") !==
      DISPATCH_THRESHOLD_WEI ||
    asBigInt(tupleField(factoryArgs, "captureCooldown", 6), "Event cooldown") !==
      CAPTURE_COOLDOWN_SECONDS
  ) {
    throw new Error("CityVaultCreated economic configuration does not match the reviewed values.");
  }

  const [tokenCode, vaultCode] = await Promise.all([
    requireRuntimeCodeWithRetry(context, "YC56T token runtime code", token),
    requireRuntimeCodeWithRetry(context, "CityVault runtime code", vault),
  ]);
  const expectedProxyCode = expectedTaxV3ProxyRuntime();
  if (tokenCode.toLowerCase() !== expectedProxyCode.toLowerCase()) {
    throw new Error(
      `Token is not the expected EIP-1167 proxy to ${FLAP_TESTNET_TAX_V3_IMPLEMENTATION}.`,
    );
  }

  const vaultInfoRaw = await retryRead("VaultPortal.getVault", () =>
    context.publicClient.readContract({
      address: FLAP_TESTNET_VAULT_PORTAL,
      abi: vaultPortalArtifact.abi,
      functionName: "getVault",
      args: [token],
    }),
  );
  assertAddress(tupleField(vaultInfoRaw, "vault", 0), vault, "VaultPortal stored vault");
  assertAddress(
    tupleField(vaultInfoRaw, "vaultFactory", 1),
    CITY_TESTNET_FACTORY,
    "VaultPortal stored factory",
  );

  const getterValues = await retryRead("launched contract getters", () =>
    Promise.all([
      context.publicClient.readContract({
        address: token,
        abi: ERC20_METADATA_ABI,
        functionName: "name",
      }),
      context.publicClient.readContract({
        address: token,
        abi: ERC20_METADATA_ABI,
        functionName: "symbol",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "taxToken",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "creator",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "treasury",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "compensationOracle",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "dispatchThreshold",
      }),
      context.publicClient.readContract({
        address: vault,
        abi: cityVaultArtifact.abi,
        functionName: "captureCooldown",
      }),
      context.publicClient.readContract({
        address: FLAP_TESTNET_PORTAL,
        abi: portalArtifact.abi,
        functionName: "getTokenV8Safe",
        args: [token],
      }),
    ]),
  );
  const [
    tokenNameRaw,
    tokenSymbolRaw,
    vaultTokenRaw,
    vaultCreatorRaw,
    vaultTreasuryRaw,
    vaultOracleRaw,
    thresholdRaw,
    cooldownRaw,
    tokenStateRaw,
  ] = getterValues;
  if (tokenNameRaw !== TOKEN_NAME || tokenSymbolRaw !== TOKEN_SYMBOL) {
    throw new Error(
      `Token metadata is ${String(tokenNameRaw)} / ${String(tokenSymbolRaw)}, expected ${TOKEN_NAME} / ${TOKEN_SYMBOL}.`,
    );
  }
  assertAddress(vaultTokenRaw, token, "CityVault taxToken getter");
  assertAddress(vaultCreatorRaw, CITY_TESTNET_DEPLOYER, "CityVault creator getter");
  assertAddress(vaultTreasuryRaw, CITY_TESTNET_TREASURY, "CityVault treasury getter");
  assertAddress(vaultOracleRaw, CITY_TESTNET_ORACLE, "CityVault oracle getter");
  if (
    asBigInt(thresholdRaw, "CityVault threshold getter") !== DISPATCH_THRESHOLD_WEI ||
    asBigInt(cooldownRaw, "CityVault cooldown getter") !== CAPTURE_COOLDOWN_SECONDS
  ) {
    throw new Error("CityVault getter configuration does not match the reviewed values.");
  }

  const portalTokenVersion = Number(
    asBigInt(tupleField(tokenStateRaw, "tokenVersion", 4), "Portal tokenVersion"),
  );
  const portalBuyTaxBps = asBigInt(
    tupleField(tokenStateRaw, "buyTaxRate", 12),
    "Portal buyTaxRate",
  );
  const portalSellTaxBps = asBigInt(
    tupleField(tokenStateRaw, "sellTaxRate", 13),
    "Portal sellTaxRate",
  );
  assertAddress(
    tupleField(tokenStateRaw, "quoteTokenAddress", 9),
    zeroAddress,
    "Portal quote token",
  );
  if (
    portalTokenVersion !== TOKEN_VERSION_TAXED_V3 ||
    portalBuyTaxBps !== BigInt(BUY_TAX_BPS) ||
    portalSellTaxBps !== BigInt(SELL_TAX_BPS) ||
    Number(asBigInt(tupleField(tokenStateRaw, "lpFeeProfile", 16), "Portal LP fee profile")) !==
      LP_FEE_STANDARD
  ) {
    throw new Error("Portal token state does not match the reviewed V3 tax configuration.");
  }

  const [latestBlock, receiptBlock] = await Promise.all([
    context.publicClient.getBlockNumber(),
    context.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  const confirmations = latestBlock - receipt.blockNumber + 1n;
  if (confirmations < BigInt(FLAP_TESTNET_REQUIRED_CONFIRMATIONS)) {
    throw new Error(`Only ${confirmations} confirmations are available.`);
  }

  console.log(`Verified transaction: ${transactionExplorerUrl(transactionHash)}`);
  console.log(`Verified token: ${addressExplorerUrl(token)}`);
  console.log(`Verified vault: ${addressExplorerUrl(vault)}`);

  return {
    transactionHash,
    transactionBlockNumber: receipt.blockNumber,
    transactionBlockHash: receipt.blockHash,
    transactionBlockTimestamp: receiptBlock.timestamp,
    confirmations,
    token,
    tokenCode,
    tokenRuntimeHash: keccak256(tokenCode),
    vault,
    vaultCode,
    vaultRuntimeHash: keccak256(vaultCode),
    tokenName: tokenNameRaw,
    tokenSymbol: tokenSymbolRaw,
    vaultDescription: String(tupleField(vaultInfoRaw, "description", 2)),
    vaultOfficial: tupleField(vaultInfoRaw, "isOfficial", 3) === true,
    vaultRiskLevel: Number(asBigInt(tupleField(vaultInfoRaw, "riskLevel", 4), "Vault risk level")),
    portalTokenStatus: Number(
      asBigInt(tupleField(tokenStateRaw, "status", 0), "Portal token status"),
    ),
    portalTokenVersion,
    portalBuyTaxBps,
    portalSellTaxBps,
  };
}
