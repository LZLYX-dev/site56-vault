import { artifacts, network } from "hardhat";
import type { Address, Hex } from "viem";
import { encodeDeployData } from "viem";

export const BSC_TESTNET_CHAIN_ID = 97;
export const BSC_TESTNET_NETWORK_NAME = "bscTestnet";
export const BSC_TESTNET_READ_ONLY_NETWORK_NAME = "bscTestnetReadOnly";
export const BSC_TESTNET_EXPLORER = "https://testnet.bscscan.com";
const TESTNET_PRIVATE_KEY_VARIABLE = "BSC_TESTNET_DEPLOYER_PRIVATE_KEY";

export type DeploymentEstimate = {
  contractName: "TestnetCompensationOracle" | "CityVaultFactory";
  initCodeBytes: number;
  gas: bigint;
};

export type TestnetDeploymentSpec =
  | {
      contractName: "TestnetCompensationOracle";
      constructorArgs: readonly [Address];
    }
  | {
      contractName: "CityVaultFactory";
      constructorArgs: readonly [];
    };

export function assertBscTestnet(
  networkName: string,
  chainId: number,
): void {
  if (networkName !== BSC_TESTNET_NETWORK_NAME) {
    throw new Error(
      `Refusing to continue: selected network is ${networkName}, expected ${BSC_TESTNET_NETWORK_NAME}.`,
    );
  }

  if (chainId !== BSC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to continue: RPC returned chainId ${chainId}, expected BSC Testnet chainId ${BSC_TESTNET_CHAIN_ID}.`,
    );
  }
}

export async function openBscTestnetContext() {
  if (process.env[TESTNET_PRIVATE_KEY_VARIABLE] !== undefined) {
    throw new Error(
      `${TESTNET_PRIVATE_KEY_VARIABLE} must not be supplied as an environment variable. Store it in the encrypted Hardhat keystore.`,
    );
  }

  const connection = await network.create();

  try {
    const publicClient = await connection.viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    // This check intentionally happens before requesting any configured
    // signing account from Hardhat's encrypted keystore.
    assertBscTestnet(connection.networkName, chainId);

    return {
      connection,
      publicClient,
      viem: connection.viem,
      chainId,
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

/**
 * Opens the keyless public-RPC profile used only for post-deployment reads.
 * Keeping this separate prevents an idempotent verifier from prompting for or
 * resolving the encrypted signing key.
 */
export async function openBscTestnetReadOnlyContext() {
  if (process.env[TESTNET_PRIVATE_KEY_VARIABLE] !== undefined) {
    throw new Error(
      `${TESTNET_PRIVATE_KEY_VARIABLE} must not be supplied to the read-only verifier.`,
    );
  }

  const connection = await network.create();
  try {
    const publicClient = await connection.viem.getPublicClient();
    const chainId = await publicClient.getChainId();
    if (connection.networkName !== BSC_TESTNET_READ_ONLY_NETWORK_NAME) {
      throw new Error(
        `Refusing read-only verification: selected network is ${connection.networkName}, expected ${BSC_TESTNET_READ_ONLY_NETWORK_NAME}.`,
      );
    }
    if (chainId !== BSC_TESTNET_CHAIN_ID) {
      throw new Error(
        `Refusing read-only verification: RPC returned chainId ${chainId}, expected ${BSC_TESTNET_CHAIN_ID}.`,
      );
    }
    return {
      connection,
      publicClient,
      viem: connection.viem,
      chainId,
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export async function getSoleTestnetDeployer(
  viem: Awaited<ReturnType<typeof openBscTestnetContext>>["viem"],
) {
  const walletClients = await viem.getWalletClients();

  if (walletClients.length !== 1) {
    throw new Error(
      `Expected exactly one BSC Testnet deployer account from the Hardhat keystore, found ${walletClients.length}.`,
    );
  }

  const [deployer] = walletClients;
  if (deployer.account === undefined) {
    throw new Error("The BSC Testnet wallet client has no deployer account.");
  }

  return deployer;
}

export async function estimateTestnetDeployments(
  publicClient: Awaited<
    ReturnType<typeof openBscTestnetContext>
  >["publicClient"],
  deployer: Awaited<ReturnType<typeof getSoleTestnetDeployer>>,
): Promise<DeploymentEstimate[]> {
  const deploymentSpecs: readonly TestnetDeploymentSpec[] = [
    {
      contractName: "TestnetCompensationOracle",
      constructorArgs: [deployer.account.address],
    },
    { contractName: "CityVaultFactory", constructorArgs: [] },
  ];

  return Promise.all(
    deploymentSpecs.map(async ({ contractName, constructorArgs }) => {
      const artifact = await artifacts.readArtifact(contractName);
      const bytecode = artifact.bytecode as Hex;

      if (bytecode === "0x") {
        throw new Error(`${contractName} has empty creation bytecode.`);
      }

      const initCode = encodeDeployData({
        abi: artifact.abi,
        bytecode,
        args: constructorArgs,
      });
      const initCodeBytes = (initCode.length - 2) / 2;
      if (initCodeBytes > 49_152) {
        throw new Error(
          `${contractName} initcode is ${initCodeBytes} bytes and exceeds the EIP-3860 limit.`,
        );
      }

      const gas = await publicClient.estimateGas({
        account: deployer.account,
        data: initCode,
      });

      return { contractName, initCodeBytes, gas };
    }),
  );
}

export function addressExplorerUrl(address: Address): string {
  return `${BSC_TESTNET_EXPLORER}/address/${address}`;
}

export function transactionExplorerUrl(hash: Hex): string {
  return `${BSC_TESTNET_EXPLORER}/tx/${hash}`;
}
