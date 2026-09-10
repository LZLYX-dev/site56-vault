import { artifacts } from "hardhat";
import type { Address, Hex } from "viem";
import {
  formatEther,
  isAddress,
  keccak256,
  zeroAddress,
} from "viem";

import type {
  getSoleTestnetDeployer,
  openBscTestnetContext,
} from "./bsc-testnet.js";
import {
  BSC_TESTNET_CHAIN_ID,
  addressExplorerUrl,
  transactionExplorerUrl,
} from "./bsc-testnet.js";
import type { LaunchParams, LaunchPlan } from "./flap-testnet-launch.js";
import {
  BUY_TAX_BPS,
  CAPTURE_COOLDOWN_SECONDS,
  CITY_TESTNET_DEPLOYER,
  CITY_TESTNET_FACTORY,
  CITY_TESTNET_ORACLE,
  CITY_TESTNET_TREASURY,
  DISPATCH_THRESHOLD_WEI,
  EXPECTED_FACTORY_RUNTIME_HASH,
  EXPECTED_ORACLE_RUNTIME_HASH,
  FLAP_TESTNET_PORTAL,
  FLAP_TESTNET_TAX_V3_IMPLEMENTATION,
  FLAP_TESTNET_VAULT_PORTAL,
  MARKET_BPS,
  SELL_TAX_BPS,
  TOKEN_VERSION_TAXED_V3,
  buildLaunchParams,
  buildNormalizedValidationData,
  predictTestnetTokenAddress,
} from "./flap-testnet-launch.js";
import { verifyExistingFlapTestnetLaunch } from "./flap-testnet-verification.js";

type TestnetContext = Awaited<ReturnType<typeof openBscTestnetContext>>;
type TestnetDeployer = Awaited<ReturnType<typeof getSoleTestnetDeployer>>;

export type FlapPreflightResult = {
  params: LaunchParams;
  predictedToken: Address;
  simulatedToken: Address;
  estimatedGas: bigint;
  gasPrice: bigint;
  estimatedFeeWithBuffer: bigint;
  balance: bigint;
  portalVersion: string;
  taxOnBondingCurveEnabled: boolean;
  factoryRegistered: boolean;
  factoryOfficial: boolean;
  factoryRiskLevel: number;
  factoryPermissionPolicy: number;
  currentOracleQuote: bigint;
  currentOracleValid: boolean;
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
    throw new Error(`${label} returned an invalid address.`);
  }
  return value;
}

async function assertLiveChain(context: TestnetContext, phase: string) {
  const chainId = await context.publicClient.getChainId();
  if (chainId !== BSC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing ${phase}: RPC returned chainId ${chainId}, expected ${BSC_TESTNET_CHAIN_ID}.`,
    );
  }
}

async function requireCode(
  context: TestnetContext,
  label: string,
  address: Address,
  expectedRuntimeHash?: Hex,
): Promise<Hex> {
  const code = await context.publicClient.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`${label} has no runtime bytecode at ${address}.`);
  }
  if (
    expectedRuntimeHash !== undefined &&
    keccak256(code).toLowerCase() !== expectedRuntimeHash.toLowerCase()
  ) {
    throw new Error(
      `${label} runtime bytecode hash changed at ${address}; refusing to use an unreviewed deployment.`,
    );
  }
  return code;
}

export async function simulateFlapTestnetLaunch(
  context: TestnetContext,
  deployer: TestnetDeployer,
  params: LaunchParams,
  vaultPortalAbi: Awaited<ReturnType<typeof artifacts.readArtifact>>["abi"],
  predictedToken: Address,
) {
  await assertLiveChain(context, "Flap launch simulation");
  const simulation = await context.publicClient.simulateContract({
    address: FLAP_TESTNET_VAULT_PORTAL,
    abi: vaultPortalAbi,
    functionName: "newTokenV6WithVault",
    args: [params],
    account: deployer.account,
    value: params.quoteAmt,
  });
  const simulatedToken = requireAddress(
    simulation.result,
    "VaultPortal simulation",
  );
  if (simulatedToken.toLowerCase() !== predictedToken.toLowerCase()) {
    throw new Error(
      `VaultPortal simulation returned ${simulatedToken}, expected ${predictedToken}.`,
    );
  }
  return { simulation, simulatedToken };
}

export async function runFlapTestnetPreflight(
  context: TestnetContext,
  deployer: TestnetDeployer,
  plan: LaunchPlan,
): Promise<FlapPreflightResult> {
  await assertLiveChain(context, "Flap preflight");
  if (
    deployer.account.address.toLowerCase() !== CITY_TESTNET_DEPLOYER.toLowerCase()
  ) {
    throw new Error(
      `Configured keystore account is ${deployer.account.address}, expected the reviewed testnet deployer ${CITY_TESTNET_DEPLOYER}.`,
    );
  }

  const [vaultPortalArtifact, portalArtifact, factoryArtifact, oracleArtifact] =
    await Promise.all([
      artifacts.readArtifact("IVaultPortal"),
      artifacts.readArtifact("IPortal"),
      artifacts.readArtifact("CityVaultFactory"),
      artifacts.readArtifact("TestnetCompensationOracle"),
    ]);

  await Promise.all([
    requireCode(context, "Flap Testnet Portal", FLAP_TESTNET_PORTAL),
    requireCode(context, "Flap Testnet VaultPortal", FLAP_TESTNET_VAULT_PORTAL),
    requireCode(
      context,
      "Flap Testnet TaxV3 implementation",
      FLAP_TESTNET_TAX_V3_IMPLEMENTATION,
    ),
    requireCode(
      context,
      "CityVaultFactory",
      CITY_TESTNET_FACTORY,
      EXPECTED_FACTORY_RUNTIME_HASH,
    ),
    requireCode(
      context,
      "TestnetCompensationOracle",
      CITY_TESTNET_ORACLE,
      EXPECTED_ORACLE_RUNTIME_HASH,
    ),
  ]);

  const params = buildLaunchParams(plan);
  if (params.quoteAmt !== 0n) {
    throw new Error("Reviewed testnet launch must use quoteAmt=0 and msg.value=0.");
  }
  const predictedToken = predictTestnetTokenAddress(params.salt);
  if (!predictedToken.toLowerCase().endsWith("7777")) {
    throw new Error(`Predicted token ${predictedToken} does not end in 7777.`);
  }
  const existingTokenCode = await context.publicClient.getCode({
    address: predictedToken,
  });
  if (existingTokenCode !== undefined && existingTokenCode !== "0x") {
    throw new Error(`Predicted token address ${predictedToken} already has code.`);
  }

  const [
    portalVersionRaw,
    taxOnBondingCurveEnabledRaw,
    spammerBlockedRaw,
    saltLockRaw,
    oracleOperatorRaw,
    oracleQuoteRaw,
    oracleValidRaw,
    factorySpecVersionRaw,
    quoteSupportedRaw,
    validationRaw,
    schemaRaw,
    registryRaw,
    policyRaw,
  ] = await Promise.all([
    context.publicClient.readContract({
      address: FLAP_TESTNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "version",
    }),
    context.publicClient.readContract({
      address: FLAP_TESTNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "enableTaxOnBondingCurve",
    }),
    context.publicClient.readContract({
      address: FLAP_TESTNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "isSpammerBlocked",
      args: [CITY_TESTNET_DEPLOYER],
    }),
    context.publicClient.readContract({
      address: FLAP_TESTNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "getSaltLock",
      args: [params.salt],
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_ORACLE,
      abi: oracleArtifact.abi,
      functionName: "operator",
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_ORACLE,
      abi: oracleArtifact.abi,
      functionName: "nativeQuote",
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_ORACLE,
      abi: oracleArtifact.abi,
      functionName: "valid",
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_FACTORY,
      abi: factoryArtifact.abi,
      functionName: "factorySpecVersion",
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_FACTORY,
      abi: factoryArtifact.abi,
      functionName: "isQuoteTokenSupported",
      args: [zeroAddress],
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_FACTORY,
      abi: factoryArtifact.abi,
      functionName: "onBeforeLaunch",
      args: [buildNormalizedValidationData()],
    }),
    context.publicClient.readContract({
      address: CITY_TESTNET_FACTORY,
      abi: factoryArtifact.abi,
      functionName: "vaultDataSchema",
    }),
    context.publicClient.readContract({
      address: FLAP_TESTNET_VAULT_PORTAL,
      abi: vaultPortalArtifact.abi,
      functionName: "vaultFactories",
      args: [CITY_TESTNET_FACTORY],
    }),
    context.publicClient.readContract({
      address: FLAP_TESTNET_VAULT_PORTAL,
      abi: vaultPortalArtifact.abi,
      functionName: "getFactoryPolicy",
      args: [CITY_TESTNET_FACTORY],
    }),
  ]);

  if (typeof portalVersionRaw !== "string" || portalVersionRaw === "") {
    throw new Error("Flap Portal returned an invalid version string.");
  }
  if (spammerBlockedRaw !== false) {
    throw new Error("The reviewed testnet deployer is blocked from token creation.");
  }

  const lockOwner = requireAddress(
    tupleField(saltLockRaw, "locker", 0),
    "Portal salt lock owner",
  );
  const lockedVersion = Number(
    tupleField<bigint | number>(saltLockRaw, "tokenVersion", 1),
  );
  if (
    lockOwner !== zeroAddress &&
    lockOwner.toLowerCase() !== CITY_TESTNET_DEPLOYER.toLowerCase()
  ) {
    throw new Error(`Salt is locked by another address: ${lockOwner}.`);
  }
  if (lockOwner !== zeroAddress && lockedVersion !== TOKEN_VERSION_TAXED_V3) {
    throw new Error(
      `Salt lock tokenVersion is ${lockedVersion}, expected ${TOKEN_VERSION_TAXED_V3}.`,
    );
  }

  const oracleOperator = requireAddress(
    oracleOperatorRaw,
    "Testnet compensation oracle operator",
  );
  if (oracleOperator.toLowerCase() !== CITY_TESTNET_DEPLOYER.toLowerCase()) {
    throw new Error("Testnet compensation oracle operator changed.");
  }
  if (typeof oracleQuoteRaw !== "bigint" || typeof oracleValidRaw !== "boolean") {
    throw new Error("Testnet compensation oracle returned invalid quote state.");
  }
  if (factorySpecVersionRaw !== "v2.2") {
    throw new Error(
      `CityVaultFactory reports spec ${String(factorySpecVersionRaw)}, expected v2.2.`,
    );
  }
  if (quoteSupportedRaw !== true) {
    throw new Error("CityVaultFactory no longer supports native BNB.");
  }
  const validationPassed = tupleField<boolean>(validationRaw, "success", 0);
  const validationReason = tupleField<string>(validationRaw, "reason", 1);
  if (!validationPassed) {
    throw new Error(`CityVaultFactory launch validation failed: ${validationReason}`);
  }

  const schemaFields = tupleField<readonly unknown[]>(schemaRaw, "fields", 1);
  const expectedFields = [
    "treasury",
    "compensationOracle",
    "dispatchThreshold",
    "captureCooldown",
  ];
  if (!Array.isArray(schemaFields) || schemaFields.length !== expectedFields.length) {
    throw new Error("CityVaultFactory vaultData schema shape changed.");
  }
  for (const [index, expectedName] of expectedFields.entries()) {
    const actualName = tupleField<string>(schemaFields[index], "name", 0);
    if (actualName !== expectedName) {
      throw new Error(
        `CityVaultFactory schema field ${index} is ${actualName}, expected ${expectedName}.`,
      );
    }
  }

  const factoryRegistered = tupleField<boolean>(registryRaw, "enabled", 0);
  const factoryOfficial = tupleField<boolean>(registryRaw, "official", 1);
  const factoryRiskLevel = Number(
    tupleField<bigint | number>(registryRaw, "riskLevel", 2),
  );
  const factoryPermissionPolicy = Number(
    tupleField<bigint | number>(policyRaw, "policy", 0),
  );
  if (factoryPermissionPolicy === 2) {
    throw new Error("VaultPortal factory permission policy is DISABLED.");
  }

  const { simulation, simulatedToken } = await simulateFlapTestnetLaunch(
    context,
    deployer,
    params,
    vaultPortalArtifact.abi,
    predictedToken,
  );
  const [estimatedGas, gasPrice, balance] = await Promise.all([
    context.publicClient.estimateContractGas({
      address: FLAP_TESTNET_VAULT_PORTAL,
      abi: vaultPortalArtifact.abi,
      functionName: "newTokenV6WithVault",
      args: [params],
      account: deployer.account,
      value: params.quoteAmt,
    }),
    context.publicClient.getGasPrice(),
    context.publicClient.getBalance({ address: deployer.account.address }),
  ]);
  const estimatedFeeWithBuffer = (estimatedGas * gasPrice * 120n) / 100n;
  if (balance < params.quoteAmt + estimatedFeeWithBuffer) {
    throw new Error(
      `Insufficient tBNB: balance ${formatEther(balance)}, require ${formatEther(params.quoteAmt + estimatedFeeWithBuffer)} including 20% gas buffer.`,
    );
  }

  return {
    params,
    predictedToken,
    simulatedToken,
    estimatedGas,
    gasPrice,
    estimatedFeeWithBuffer,
    balance,
    portalVersion: portalVersionRaw,
    taxOnBondingCurveEnabled: taxOnBondingCurveEnabledRaw === true,
    factoryRegistered,
    factoryOfficial,
    factoryRiskLevel,
    factoryPermissionPolicy,
    currentOracleQuote: oracleQuoteRaw,
    currentOracleValid: oracleValidRaw,
  };
}

export function printFlapPreflight(result: FlapPreflightResult): void {
  console.log(`Portal version: ${result.portalVersion}`);
  console.log(
    `Tax on bonding curve enabled: ${result.taxOnBondingCurveEnabled}`,
  );
  console.log(`Predicted token: ${result.predictedToken}`);
  console.log(`Token explorer: ${addressExplorerUrl(result.predictedToken)}`);
  console.log(`Simulation returned: ${result.simulatedToken}`);
  console.log(`Estimated launch gas: ${result.estimatedGas}`);
  console.log(
    `Estimated fee with 20% buffer: ${formatEther(result.estimatedFeeWithBuffer)} tBNB`,
  );
  console.log(`Deployer balance: ${formatEther(result.balance)} tBNB`);
  console.log(
    `Factory registry: enabled=${result.factoryRegistered}, official=${result.factoryOfficial}, riskLevel=${result.factoryRiskLevel}, policy=${result.factoryPermissionPolicy}`,
  );
  console.log(
    `Test oracle state: quote=${result.currentOracleQuote}, valid=${result.currentOracleValid}`,
  );
  console.log(`Factory: ${addressExplorerUrl(CITY_TESTNET_FACTORY)}`);
  console.log(`Oracle: ${addressExplorerUrl(CITY_TESTNET_ORACLE)}`);
}

export async function broadcastFlapTestnetLaunch(
  context: TestnetContext,
  deployer: TestnetDeployer,
  preflight: FlapPreflightResult,
) {
  const vaultPortalArtifact = await artifacts.readArtifact("IVaultPortal");

  await assertLiveChain(context, "final Flap launch simulation");
  const { simulation } = await simulateFlapTestnetLaunch(
    context,
    deployer,
    preflight.params,
    vaultPortalArtifact.abi,
    preflight.predictedToken,
  );
  await assertLiveChain(context, "Flap launch broadcast");

  const transactionHash = await deployer.writeContract(simulation.request);
  console.log(`Broadcast transaction: ${transactionExplorerUrl(transactionHash)}`);
  // The transaction hash is the recovery handle. Postconditions deliberately
  // wait for multiple confirmations and retry read-after-write RPC calls, so a
  // lagging endpoint cannot turn a successful launch into a reason to resend.
  const verified = await verifyExistingFlapTestnetLaunch(
    context,
    transactionHash,
    preflight.params,
  );

  return {
    transactionHash,
    blockNumber: verified.transactionBlockNumber,
    token: verified.token,
    vault: verified.vault,
  };
}
