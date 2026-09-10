import { readFile, writeFile } from "node:fs/promises";

import { artifacts } from "hardhat";
import type { Address, Hex } from "viem";
import {
  encodeDeployData,
  formatEther,
  getAddress,
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
import {
  V2_CAPTURE_COOLDOWN_SECONDS,
  V2_DEPLOYER,
  V2_DISPATCH_THRESHOLD_WEI,
  V2_ENVIRONMENT,
  V2_INFRA_MANIFEST_URL,
  V2_TREASURY,
  loadV2InfraManifest,
  type V2InfraContractRecord,
  type V2InfraManifest,
} from "./flap-testnet-v2.js";

type TestnetContext = Pick<
  Awaited<ReturnType<typeof openBscTestnetContext>>,
  "publicClient"
>;
type TestnetDeployer = Awaited<ReturnType<typeof getSoleTestnetDeployer>>;
/** The preflight needs an address for `eth_call`/gas estimation, not a key. */
export type V2DeployerIdentity = {
  account: { address: Address };
};
type ChainReadContext = Pick<TestnetContext, "publicClient">;

type DeployableContractName =
  | "TestnetCompensationOracle"
  | "CityVaultFactory";

type DeploymentBuild = {
  contractName: DeployableContractName;
  constructorArgs: readonly unknown[];
  abi: Awaited<ReturnType<typeof artifacts.readArtifact>>["abi"];
  bytecode: Hex;
  initCode: Hex;
  initCodeHash: Hex;
  initCodeBytes: number;
};

export type V2InfraEstimate = DeploymentBuild & {
  simulatedRuntime: Hex;
  estimatedGas: bigint;
  gasLimit: bigint;
};

export type V2InfraPreflight = {
  deployer: Address;
  balance: bigint;
  gasPrice: bigint;
  totalEstimatedGas: bigint;
  requiredWithBuffer: bigint;
  deployments: readonly V2InfraEstimate[];
};

const JOURNAL_URL = new URL(
  "../../deployments/flap-bsc-testnet-v2-infra-journal.json",
  import.meta.url,
);

type DeploymentJournal = {
  schemaVersion: 1;
  environment: typeof V2_ENVIRONMENT;
  chainId: 97;
  testnetOnly: true;
  deployer: Address;
  treasury: Address;
  oracle?: V2InfraContractRecord & { initCodeHash: Hex };
  factory?: V2InfraContractRecord & { initCodeHash: Hex };
};

function bufferedGas(gas: bigint): bigint {
  return (gas * 120n + 99n) / 100n;
}

async function assertLiveChain(
  context: ChainReadContext,
  phase: string,
): Promise<void> {
  const chainId = await context.publicClient.getChainId();
  if (chainId !== BSC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing ${phase}: RPC returned chainId ${chainId}, expected ${BSC_TESTNET_CHAIN_ID}.`,
    );
  }
}

async function buildDeployments(): Promise<readonly DeploymentBuild[]> {
  const [oracleArtifact, factoryArtifact] = await Promise.all([
    artifacts.readArtifact("TestnetCompensationOracle"),
    artifacts.readArtifact("CityVaultFactory"),
  ]);
  const specs = [
    {
      contractName: "TestnetCompensationOracle" as const,
      constructorArgs: [V2_DEPLOYER] as const,
      artifact: oracleArtifact,
    },
    {
      contractName: "CityVaultFactory" as const,
      constructorArgs: [] as const,
      artifact: factoryArtifact,
    },
  ];
  return specs.map(({ contractName, constructorArgs, artifact }) => {
    const bytecode = artifact.bytecode as Hex;
    if (bytecode === "0x") throw new Error(`${contractName} bytecode is empty.`);
    const initCode = encodeDeployData({
      abi: artifact.abi,
      bytecode,
      args: constructorArgs,
    });
    const initCodeBytes = (initCode.length - 2) / 2;
    if (initCodeBytes > 49_152) {
      throw new Error(
        `${contractName} initcode is ${initCodeBytes} bytes and exceeds EIP-3860.`,
      );
    }
    return {
      contractName,
      constructorArgs,
      abi: artifact.abi,
      bytecode,
      initCode,
      initCodeHash: keccak256(initCode),
      initCodeBytes,
    };
  });
}

async function simulateDeployment(
  context: TestnetContext,
  deployer: V2DeployerIdentity,
  build: DeploymentBuild,
): Promise<{ simulatedRuntime: Hex; estimatedGas: bigint }> {
  await assertLiveChain(context, `${build.contractName} deployment simulation`);
  const [callResult, estimatedGas] = await Promise.all([
    context.publicClient.call({
      account: deployer.account.address,
      data: build.initCode,
    }),
    context.publicClient.estimateGas({
      account: deployer.account.address,
      data: build.initCode,
    }),
  ]);
  if (callResult.data === undefined || callResult.data === "0x") {
    throw new Error(
      `${build.contractName} eth_call deployment simulation returned no runtime bytecode.`,
    );
  }
  return { simulatedRuntime: callResult.data, estimatedGas };
}

export async function runV2InfraPreflight(
  context: TestnetContext,
  deployer: V2DeployerIdentity,
): Promise<V2InfraPreflight> {
  await assertLiveChain(context, "V2 infrastructure preflight");
  if (getAddress(deployer.account.address) !== V2_DEPLOYER) {
    throw new Error(
      `Configured account is ${deployer.account.address}, expected ${V2_DEPLOYER}.`,
    );
  }
  if (V2_TREASURY === V2_DEPLOYER) {
    throw new Error("V2 treasury must be independent from the deployer.");
  }

  const builds = await buildDeployments();
  const [simulations, gasPrice, balance] = await Promise.all([
    Promise.all(
      builds.map((build) => simulateDeployment(context, deployer, build)),
    ),
    context.publicClient.getGasPrice(),
    context.publicClient.getBalance({ address: deployer.account.address }),
  ]);
  const deployments = builds.map((build, index) => ({
    ...build,
    ...simulations[index],
    gasLimit: bufferedGas(simulations[index].estimatedGas),
  }));
  const totalEstimatedGas = deployments.reduce(
    (sum, deployment) => sum + deployment.estimatedGas,
    0n,
  );
  const requiredWithBuffer = deployments.reduce(
    (sum, deployment) => sum + deployment.gasLimit * gasPrice,
    0n,
  );
  if (balance < requiredWithBuffer) {
    throw new Error(
      `Insufficient tBNB: ${formatEther(balance)} available, ${formatEther(requiredWithBuffer)} required for V2 infrastructure with explicit gas buffers.`,
    );
  }
  return {
    deployer: getAddress(deployer.account.address),
    balance,
    gasPrice,
    totalEstimatedGas,
    requiredWithBuffer,
    deployments,
  };
}

export function printV2InfraPreflight(result: V2InfraPreflight): void {
  console.log(`Network: BSC Testnet (chainId ${BSC_TESTNET_CHAIN_ID})`);
  console.log(`Deployer: ${result.deployer}`);
  console.log(`Independent treasury: ${V2_TREASURY}`);
  console.log(`Capture cooldown: ${V2_CAPTURE_COOLDOWN_SECONDS}`);
  console.log(`Deployer balance: ${formatEther(result.balance)} tBNB`);
  for (const deployment of result.deployments) {
    console.log(
      `${deployment.contractName}: initcode=${deployment.initCodeBytes} bytes, estimate=${deployment.estimatedGas}, explicit gasLimit=${deployment.gasLimit}, initCodeHash=${deployment.initCodeHash}`,
    );
  }
  console.log(
    `Infrastructure worst-case fee at current gas price: ${formatEther(result.requiredWithBuffer)} tBNB`,
  );
}

async function writeJsonAtomic(url: URL, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = new URL(`${url.pathname}.${process.pid}.tmp`, url);
  await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
  try {
    await writeFile(url, serialized, { encoding: "utf8", flag: "wx" });
  } finally {
    // The temporary file contains public deployment data only. Leaving it on
    // failure is preferable to an overwrite because it is a recovery record.
  }
}

async function readJournal(): Promise<DeploymentJournal> {
  try {
    return JSON.parse(await readFile(JOURNAL_URL, "utf8")) as DeploymentJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      environment: V2_ENVIRONMENT,
      chainId: 97,
      testnetOnly: true,
      deployer: V2_DEPLOYER,
      treasury: V2_TREASURY,
    };
  }
}

async function saveJournal(journal: DeploymentJournal): Promise<void> {
  const serialized = `${JSON.stringify(journal, null, 2)}\n`;
  await writeFile(JOURNAL_URL, serialized, { encoding: "utf8" });
}

async function verifyDeploymentRecord(
  context: ChainReadContext,
  build: DeploymentBuild,
  record: V2InfraContractRecord & { initCodeHash?: Hex },
): Promise<Hex> {
  if (
    record.initCodeHash !== undefined &&
    record.initCodeHash.toLowerCase() !== build.initCodeHash.toLowerCase()
  ) {
    throw new Error(`${build.contractName} journal initcode hash changed.`);
  }
  const [receipt, transaction, code] = await Promise.all([
    context.publicClient.getTransactionReceipt({ hash: record.transactionHash }),
    context.publicClient.getTransaction({ hash: record.transactionHash }),
    context.publicClient.getCode({ address: record.address }),
  ]);
  if (receipt.status !== "success") {
    throw new Error(`${build.contractName} deployment transaction reverted.`);
  }
  if (
    receipt.from.toLowerCase() !== V2_DEPLOYER.toLowerCase() ||
    receipt.to !== null ||
    receipt.contractAddress?.toLowerCase() !== record.address.toLowerCase()
  ) {
    throw new Error(`${build.contractName} receipt identity mismatch.`);
  }
  if (
    transaction.input.toLowerCase() !== build.initCode.toLowerCase() ||
    transaction.value !== 0n
  ) {
    throw new Error(`${build.contractName} transaction input is not the reviewed initcode.`);
  }
  if (code === undefined || code === "0x") {
    throw new Error(`${build.contractName} has no runtime code at ${record.address}.`);
  }
  const runtimeHash = keccak256(code);
  if (runtimeHash.toLowerCase() !== record.runtimeBytecodeHash.toLowerCase()) {
    throw new Error(`${build.contractName} runtime code hash mismatch.`);
  }
  return code;
}

async function deployOne(
  context: TestnetContext,
  deployer: TestnetDeployer,
  estimate: V2InfraEstimate,
): Promise<V2InfraContractRecord & { initCodeHash: Hex }> {
  await assertLiveChain(context, `${estimate.contractName} final simulation`);
  await simulateDeployment(context, deployer, estimate);
  await assertLiveChain(context, `${estimate.contractName} broadcast`);
  const hash = await deployer.deployContract({
    account: deployer.account,
    abi: estimate.abi,
    bytecode: estimate.bytecode,
    args: estimate.constructorArgs,
    gas: estimate.gasLimit,
  });
  console.log(`${estimate.contractName} transaction: ${transactionExplorerUrl(hash)}`);
  const receipt = await context.publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 60_000,
    pollingInterval: 1_500,
  });
  if (
    receipt.status !== "success" ||
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`${estimate.contractName} deployment failed: ${hash}.`);
  }
  const address = getAddress(receipt.contractAddress);
  const code = await context.publicClient.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`${estimate.contractName} runtime code is unavailable.`);
  }
  const record = {
    address,
    transactionHash: hash,
    runtimeBytecodeHash: keccak256(code),
    initCodeHash: estimate.initCodeHash,
  };
  await verifyDeploymentRecord(context, estimate, record);
  console.log(`${estimate.contractName}: ${addressExplorerUrl(address)}`);
  return record;
}

async function validateV2InfraContracts(
  context: ChainReadContext,
  oracleAddress: Address,
  factoryAddress: Address,
): Promise<Address> {
  const [oracleArtifact, factoryArtifact] = await Promise.all([
    artifacts.readArtifact("TestnetCompensationOracle"),
    artifacts.readArtifact("CityVaultFactory"),
  ]);
  const [operator, nativeQuote, valid, defaultQuote, noDelay, helper] =
    await Promise.all([
      context.publicClient.readContract({
        address: oracleAddress,
        abi: oracleArtifact.abi,
        functionName: "operator",
      }),
      context.publicClient.readContract({
        address: oracleAddress,
        abi: oracleArtifact.abi,
        functionName: "nativeQuote",
      }),
      context.publicClient.readContract({
        address: oracleAddress,
        abi: oracleArtifact.abi,
        functionName: "valid",
      }),
      context.publicClient.readContract({
        address: oracleAddress,
        abi: oracleArtifact.abi,
        functionName: "quoteTokenToNative",
        args: [zeroAddress, 0n],
      }),
      context.publicClient.readContract({
        address: factoryAddress,
        abi: factoryArtifact.abi,
        functionName: "NO_CAPTURE_DELAY",
      }),
      context.publicClient.readContract({
        address: factoryAddress,
        abi: factoryArtifact.abi,
        functionName: "vaultDeployer",
      }),
    ]);
  if (
    typeof operator !== "string" ||
    !isAddress(operator) ||
    getAddress(operator) !== V2_DEPLOYER
  ) {
    throw new Error("V2 test oracle operator mismatch.");
  }
  if (
    nativeQuote !== 0n ||
    valid !== false ||
    !Array.isArray(defaultQuote) ||
    defaultQuote[0] !== 0n ||
    defaultQuote[1] !== false
  ) {
    throw new Error("V2 test oracle did not start fail-closed.");
  }
  if (noDelay !== 0n) {
    throw new Error(`V2 factory NO_CAPTURE_DELAY is ${String(noDelay)}, expected 0.`);
  }
  if (typeof helper !== "string" || !isAddress(helper)) {
    throw new Error("V2 factory returned an invalid vault deployer address.");
  }
  const helperAddress = getAddress(helper);
  const helperCode = await context.publicClient.getCode({ address: helperAddress });
  if (helperCode === undefined || helperCode === "0x") {
    throw new Error("V2 CityVaultDeployer helper has no runtime code.");
  }
  return helperAddress;
}

export async function verifyV2InfraManifest(
  context: ChainReadContext,
  manifest: V2InfraManifest,
): Promise<void> {
  await assertLiveChain(context, "V2 infrastructure verification");
  const builds = await buildDeployments();
  await Promise.all([
    verifyDeploymentRecord(context, builds[0], manifest.oracle),
    verifyDeploymentRecord(context, builds[1], manifest.factory),
  ]);
  const helper = await validateV2InfraContracts(
    context,
    manifest.oracle.address,
    manifest.factory.address,
  );
  if (helper !== manifest.factory.vaultDeployer) {
    throw new Error("V2 factory helper address differs from the manifest.");
  }
}

export async function deployV2Infra(
  context: TestnetContext,
  deployer: TestnetDeployer,
  preflight: V2InfraPreflight,
): Promise<V2InfraManifest> {
  try {
    const existing = await loadV2InfraManifest();
    await verifyV2InfraManifest(context, existing);
    console.log("V2 infrastructure already exists and matches; no transaction sent.");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) throw error;
    }
  }

  const journal = await readJournal();
  if (
    journal.environment !== V2_ENVIRONMENT ||
    journal.chainId !== 97 ||
    journal.testnetOnly !== true ||
    journal.deployer !== V2_DEPLOYER ||
    journal.treasury !== V2_TREASURY
  ) {
    throw new Error("V2 infrastructure recovery journal identity mismatch.");
  }

  let oracle = journal.oracle;
  if (oracle === undefined) {
    oracle = await deployOne(context, deployer, preflight.deployments[0]);
    journal.oracle = oracle;
    await saveJournal(journal);
  } else {
    await verifyDeploymentRecord(context, preflight.deployments[0], oracle);
  }

  let factory = journal.factory;
  if (factory === undefined) {
    factory = await deployOne(context, deployer, preflight.deployments[1]);
    journal.factory = factory;
    await saveJournal(journal);
  } else {
    await verifyDeploymentRecord(context, preflight.deployments[1], factory);
  }

  const vaultDeployer = await validateV2InfraContracts(
    context,
    oracle.address,
    factory.address,
  );
  const manifest: V2InfraManifest = {
    schemaVersion: 1,
    environment: V2_ENVIRONMENT,
    chainId: 97,
    testnetOnly: true,
    deployer: V2_DEPLOYER,
    treasury: V2_TREASURY,
    oracle,
    factory: { ...factory, vaultDeployer },
  };
  await writeJsonAtomic(V2_INFRA_MANIFEST_URL, {
    ...manifest,
    reviewedConfiguration: {
      captureCooldownSeconds: V2_CAPTURE_COOLDOWN_SECONDS.toString(),
      dispatchThresholdWei: V2_DISPATCH_THRESHOLD_WEI.toString(),
      buyTaxBps: 300,
      sellTaxBps: 300,
      marketBps: 10_000,
      cityRevenueBps: 7_000,
      upgradeCompensationBps: 3_000,
    },
    notice:
      "TESTNET ONLY. Contains public addresses and transaction evidence only; no private key or password.",
  });
  await verifyV2InfraManifest(context, manifest);
  return manifest;
}
