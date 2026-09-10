import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  paths: {
    // Flap's canonical interfaces live under src/flap/.
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  solidity: {
    version: "0.8.36",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 31337,
    },
    bscTestnet: {
      type: "http",
      chainType: "generic",
      chainId: 97,
      url: configVariable("BSC_TESTNET_RPC_URL"),
      accounts: [configVariable("BSC_TESTNET_DEPLOYER_PRIVATE_KEY")],
    },
    // Twelve deterministic, testnet-only actors used by the live multi-wallet
    // lifecycle exercise. The mnemonic lives only in Hardhat's encrypted
    // production keystore; no derived key is written to this repository.
    bscTestnetE2E: {
      type: "http",
      chainType: "generic",
      chainId: 97,
      url: configVariable("BSC_TESTNET_RPC_URL"),
      accounts: {
        mnemonic: configVariable("BSC_TESTNET_E2E_MNEMONIC"),
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 12,
      },
    },
    bscTestnetReadOnly: {
      type: "http",
      chainType: "generic",
      chainId: 97,
      url: "https://bsc-testnet-dataseed.bnbchain.org",
    },
    bscMainnet: {
      type: "http",
      chainType: "generic",
      chainId: 56,
      url: configVariable("BSC_MAINNET_RPC_URL"),
      // Deliberately read-only. Mainnet signing must use the audited release
      // flow with a hardware wallet and the published Safe, never a config key.
    },
    bscMainnetReadOnly: {
      type: "http",
      chainType: "generic",
      chainId: 56,
      url: "https://bsc-dataseed.bnbchain.org",
      // Public RPC only. This profile intentionally has no accounts and can
      // never sign or broadcast a mainnet transaction.
    },
    bscMainnetFork: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 56,
      forking: {
        url: configVariable("BSC_MAINNET_ARCHIVE_RPC_URL"),
        httpHeaders: {
          "User-Agent": "site56-hardhat-fork/1.0",
          Origin: "https://site56.city",
        },
      },
      // Local ephemeral accounts only. Transactions on this network mutate an
      // in-memory fork and can never be broadcast to BSC mainnet.
    },
  },
  test: {
    solidity: {
      fuzz: {
        runs: 256,
      },
    },
  },
});
