import { artifacts, network } from "hardhat";
import {
  formatEther,
  formatUnits,
  getAddress,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";

import {
  BSC_MAINNET_CHAIN_ID,
  FLAP_MAINNET_PORTAL,
  FLAP_MAINNET_TAX_V3_IMPLEMENTATION,
  FLAP_MAINNET_VAULT_PORTAL,
  SITE56_ANTI_FARMER_DURATION_SECONDS,
  SITE56_BUY_TAX_BPS,
  SITE56_DISPATCH_THRESHOLD_WEI,
  SITE56_FIRST_CLAIM_TREASURY,
  SITE56_SELL_TAX_BPS,
  buildSite56LaunchParams,
  buildSite56NormalizedValidationData,
  mineSite56VanitySalt,
} from "./lib/site56-mainnet.js";

const FIRST_CLAIM_PRICE = parseUnits("560000", 18);
const FIRST_CAPTURE_PAYMENT = parseUnits("728000", 18);
const FIRST_CAPTURE_OWNER_AMOUNT = parseUnits("672000", 18);
const FIRST_CAPTURE_BLACK_HOLE_AMOUNT = parseUnits("56000", 18);
const MAX_GRADUATION_BUYS = 12;
const GRADUATION_BUY_SIZE = parseEther("10");

const tokenAbi = parseAbi([
  "function taxProcessor() view returns (address)",
  "function buyTaxRate() view returns (uint16)",
  "function sellTaxRate() view returns (uint16)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const taxProcessorAbi = parseAbi([
  "function dispatch()",
  "function marketAddress() view returns (address)",
  "function marketQuoteBalance() view returns (uint256)",
  "function feeQuoteBalance() view returns (uint256)",
]);

function tupleField<T>(value: unknown, name: string, index: number): T {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  return (record?.[name] ?? (value as readonly unknown[])?.[index]) as T;
}

async function main(): Promise<void> {
  const connection = await network.create();
  try {
    const { viem, networkHelpers } = connection;
    const client = await viem.getPublicClient();
    if (
      connection.networkName !== "bscMainnetFork" ||
      (await client.getChainId()) !== BSC_MAINNET_CHAIN_ID
    ) {
      throw new Error(
        `Refusing fork test: network=${connection.networkName}, chainId=${await client.getChainId()}.`,
      );
    }

    const [launcher, secondBuyer] = await viem.getWalletClients();
    const [vaultPortalArtifact, portalArtifact] = await Promise.all([
      artifacts.readArtifact("IVaultPortal"),
      artifacts.readArtifact("IPortal"),
    ]);

    for (const [label, address] of [
      ["Flap Portal", FLAP_MAINNET_PORTAL],
      ["Flap VaultPortal", FLAP_MAINNET_VAULT_PORTAL],
      ["Flap Tax V3 implementation", FLAP_MAINNET_TAX_V3_IMPLEMENTATION],
    ] as const) {
      const code = await client.getCode({ address });
      if (code === undefined || code === "0x") {
        throw new Error(`${label} has no bytecode on the fork at ${address}.`);
      }
    }

    const factory = await viem.deployContract("CityVaultFactory");
    const validation = await factory.read.onBeforeLaunch([
      buildSite56NormalizedValidationData(),
    ]);
    if (tupleField<boolean>(validation, "success", 0) !== true) {
      throw new Error(
        `Factory rejected the exact Site 56 mainnet economics: ${tupleField<string>(validation, "reason", 1)}`,
      );
    }

    const mined = mineSite56VanitySalt(
      `site56-mainnet-fork-${await client.getBlockNumber()}-${factory.address}`,
    );
    const params = buildSite56LaunchParams({
      metadataCid: "site56-mainnet-fork-only-not-a-production-cid",
      salt: mined.salt,
      vaultFactory: factory.address,
    });

    for (const [label, invalidParams] of [
      ["buy tax", { ...params, buyTaxRate: SITE56_BUY_TAX_BPS - 1 }],
      ["sell tax", { ...params, sellTaxRate: SITE56_SELL_TAX_BPS + 1 }],
      ["vault allocation", { ...params, mktBps: 9_999 }],
    ] as const) {
      let rejected = false;
      try {
        await client.simulateContract({
          account: launcher.account,
          address: FLAP_MAINNET_VAULT_PORTAL,
          abi: vaultPortalArtifact.abi,
          functionName: "newTokenV6WithVault",
          args: [invalidParams],
          value: 0n,
        });
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`Flap VaultPortal accepted an invalid Site 56 ${label}.`);
      }
    }

    const launchSimulation = await client.simulateContract({
      account: launcher.account,
      address: FLAP_MAINNET_VAULT_PORTAL,
      abi: vaultPortalArtifact.abi,
      functionName: "newTokenV6WithVault",
      args: [params],
      value: 0n,
    });
    const token = getAddress(launchSimulation.result as Address);
    if (token.toLowerCase() !== mined.predictedToken.toLowerCase()) {
      throw new Error(`Launch simulation returned ${token}; expected ${mined.predictedToken}.`);
    }
    const launchHash = await launcher.writeContract(launchSimulation.request);
    const launchReceipt = await client.waitForTransactionReceipt({ hash: launchHash });
    if (launchReceipt.status !== "success") throw new Error("Fork launch reverted.");

    const processor = getAddress(
      await client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "taxProcessor",
      }),
    );
    const vault = getAddress(
      await client.readContract({
        address: processor,
        abi: taxProcessorAbi,
        functionName: "marketAddress",
      }),
    );
    const vaultContract = await viem.getContractAt("CityVault", vault);
    const [buyTax, sellTax, taxToken, treasury, threshold, cooldown] =
      await Promise.all([
        client.readContract({ address: token, abi: tokenAbi, functionName: "buyTaxRate" }),
        client.readContract({ address: token, abi: tokenAbi, functionName: "sellTaxRate" }),
        vaultContract.read.taxToken(),
        vaultContract.read.treasury(),
        vaultContract.read.dispatchThreshold(),
        vaultContract.read.captureCooldown(),
      ]);
    const treasuryAddress = getAddress(String(treasury));
    if (
      Number(buyTax) !== SITE56_BUY_TAX_BPS ||
      Number(sellTax) !== SITE56_SELL_TAX_BPS ||
      String(taxToken).toLowerCase() !== token.toLowerCase() ||
      treasuryAddress.toLowerCase() !== SITE56_FIRST_CLAIM_TREASURY.toLowerCase() ||
      (threshold as bigint) !== SITE56_DISPATCH_THRESHOLD_WEI ||
      (cooldown as bigint) !== 0n
    ) {
      throw new Error("Fork launch produced a token or vault with unexpected immutable parameters.");
    }

    async function buy(buyer: typeof launcher, amount: bigint): Promise<void> {
      const simulation = await client.simulateContract({
        account: buyer.account,
        address: FLAP_MAINNET_PORTAL,
        abi: portalArtifact.abi,
        functionName: "swapExactInput",
        args: [
          {
            inputToken: zeroAddress,
            outputToken: token,
            inputAmount: amount,
            minOutputAmount: 0n,
            permitData: "0x",
          },
        ],
        value: amount,
      });
      const hash = await buyer.writeContract(simulation.request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Fork buy reverted.");
    }

    await buy(launcher, parseEther("1"));
    await buy(secondBuyer, parseEther("1"));

    const launcherTokens = await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [launcher.account.address],
    });
    const secondTokens = await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [secondBuyer.account.address],
    });
    if (launcherTokens < FIRST_CLAIM_PRICE || secondTokens < FIRST_CAPTURE_PAYMENT) {
      throw new Error(
        `Fork buyers received too few tokens: ${formatUnits(launcherTokens, 18)} / ${formatUnits(secondTokens, 18)}.`,
      );
    }

    for (const actor of [launcher, secondBuyer]) {
      const approval = await client.simulateContract({
        account: actor.account,
        address: token,
        abi: tokenAbi,
        functionName: "approve",
        args: [vault, maxUint256],
      });
      await client.waitForTransactionReceipt({
        hash: await actor.writeContract(approval.request),
      });
    }

    const [treasuryBeforeClaim, launcherBeforeClaim] = await Promise.all([
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [treasuryAddress],
      }),
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [launcher.account.address],
      }),
    ]);
    const claim = await client.simulateContract({
      account: launcher.account,
      address: vault,
      abi: vaultContract.abi,
      functionName: "claimCity",
      args: [0, FIRST_CLAIM_PRICE],
    });
    await client.waitForTransactionReceipt({
      hash: await launcher.writeContract(claim.request),
    });
    const [treasuryAfterClaim, launcherAfterClaim] = await Promise.all([
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [treasuryAddress],
      }),
      client.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [launcher.account.address],
      }),
    ]);
    if (
      treasuryAfterClaim !== treasuryBeforeClaim + FIRST_CLAIM_PRICE ||
      launcherAfterClaim !== launcherBeforeClaim - FIRST_CLAIM_PRICE
    ) {
      throw new Error("First claim did not transfer exactly 560,000 tokens to the immutable treasury.");
    }

    let ownerRevertObserved = false;
    try {
      await client.simulateContract({
        account: launcher.account,
        address: vault,
        abi: vaultContract.abi,
        functionName: "captureCity",
        args: [0, FIRST_CAPTURE_PAYMENT, maxUint256, 0n],
      });
    } catch {
      ownerRevertObserved = true;
    }
    if (!ownerRevertObserved) throw new Error("Current-owner capture unexpectedly succeeded.");

    const blackHole = getAddress(String(await vaultContract.read.BLACK_HOLE()));
    const [oldOwnerBeforeCapture, captorBeforeCapture, blackHoleBeforeCapture] =
      await Promise.all([
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [launcher.account.address],
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [secondBuyer.account.address],
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [blackHole],
        }),
      ]);
    const capture = await client.simulateContract({
      account: secondBuyer.account,
      address: vault,
      abi: vaultContract.abi,
      functionName: "captureCity",
      args: [0, FIRST_CAPTURE_PAYMENT, maxUint256, 0n],
    });
    await client.waitForTransactionReceipt({
      hash: await secondBuyer.writeContract(capture.request),
    });
    const city = await vaultContract.read.getCity([0]);
    if (
      String(tupleField(city, "owner", 0)).toLowerCase() !==
      secondBuyer.account.address.toLowerCase()
    ) {
      throw new Error("City 0 owner did not change after the fork capture.");
    }
    const [oldOwnerAfterCapture, captorAfterCapture, blackHoleAfterCapture, vaultTokenBalance] =
      await Promise.all([
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [launcher.account.address],
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [secondBuyer.account.address],
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [blackHole],
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [vault],
        }),
      ]);
    if (
      oldOwnerAfterCapture !== oldOwnerBeforeCapture + FIRST_CAPTURE_OWNER_AMOUNT ||
      captorAfterCapture !== captorBeforeCapture - FIRST_CAPTURE_PAYMENT ||
      blackHoleAfterCapture !== blackHoleBeforeCapture + FIRST_CAPTURE_BLACK_HOLE_AMOUNT ||
      vaultTokenBalance !== 0n
    ) {
      throw new Error("Capture did not settle the exact 130% = 120% owner + 10% black-hole token path.");
    }

    async function dispatchPendingTax(): Promise<bigint> {
      const pending = await client.readContract({
        address: processor,
        abi: taxProcessorAbi,
        functionName: "marketQuoteBalance",
      });
      if (pending > 0n) {
        const simulation = await client.simulateContract({
          account: launcher.account,
          address: processor,
          abi: taxProcessorAbi,
          functionName: "dispatch",
        });
        await client.waitForTransactionReceipt({
          hash: await launcher.writeContract(simulation.request),
        });
      }
      return pending;
    }

    const bondingTaxDispatched = await dispatchPendingTax();
    const compensationAfterBonding =
      (await vaultContract.read.compensationAvailable()) as bigint;
    if (bondingTaxDispatched === 0n || compensationAfterBonding === 0n) {
      throw new Error("Bonding-curve tax did not reach the CityVault 70/30 accounting path.");
    }

    let state = await client.readContract({
      address: FLAP_MAINNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "getTokenV8Safe",
      args: [token],
    });
    let graduationBuys = 0;
    while (Number(tupleField(state, "status", 0)) !== 4) {
      if (graduationBuys >= MAX_GRADUATION_BUYS) {
        throw new Error(
          `Token did not graduate after ${MAX_GRADUATION_BUYS} × ${formatEther(GRADUATION_BUY_SIZE)} BNB fork buys.`,
        );
      }
      await buy(launcher, GRADUATION_BUY_SIZE);
      graduationBuys += 1;
      state = await client.readContract({
        address: FLAP_MAINNET_PORTAL,
        abi: portalArtifact.abi,
        functionName: "getTokenV8Safe",
        args: [token],
      });
    }
    const pool = getAddress(tupleField<Address>(state, "pool", 14));
    if (pool === zeroAddress) throw new Error("Graduated token has no DEX pool.");

    await networkHelpers.time.increase(
      Number(SITE56_ANTI_FARMER_DURATION_SECONDS + 1n),
    );
    const sellBalance = await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [launcher.account.address],
    });
    const sellInput = sellBalance / 100n;
    const portalApproval = await client.simulateContract({
      account: launcher.account,
      address: token,
      abi: tokenAbi,
      functionName: "approve",
      args: [FLAP_MAINNET_PORTAL, maxUint256],
    });
    await client.waitForTransactionReceipt({
      hash: await launcher.writeContract(portalApproval.request),
    });
    const sell = await client.simulateContract({
      account: launcher.account,
      address: FLAP_MAINNET_PORTAL,
      abi: portalArtifact.abi,
      functionName: "swapExactInput",
      args: [
        {
          inputToken: token,
          outputToken: zeroAddress,
          inputAmount: sellInput,
          minOutputAmount: 0n,
          permitData: "0x",
        },
      ],
    });
    await client.waitForTransactionReceipt({
      hash: await launcher.writeContract(sell.request),
    });
    const dexTaxDispatched = await dispatchPendingTax();
    const compensationAfterDex =
      (await vaultContract.read.compensationAvailable()) as bigint;
    if (dexTaxDispatched === 0n || compensationAfterDex <= compensationAfterBonding) {
      throw new Error("Post-graduation sell tax did not reach CityVault accounting.");
    }

    console.log("SITE 56 MAINNET FORK PASSED");
    console.log(`Fork block: ${launchReceipt.blockNumber}`);
    console.log(`Factory: ${factory.address}`);
    console.log(`Token: ${token}`);
    console.log(`Vault: ${vault}`);
    console.log(`TaxProcessor: ${processor}`);
    console.log(`DEX pool: ${pool}`);
    console.log(`Treasury: ${treasuryAddress}`);
    console.log(`Vanity salt iterations: ${mined.iterations}`);
    console.log(`Graduation buys: ${graduationBuys} × 10 BNB after two 1 BNB buys`);
    console.log(`Bonding tax dispatched: ${formatEther(bondingTaxDispatched)} BNB`);
    console.log(`DEX tax dispatched: ${formatEther(dexTaxDispatched)} BNB`);
    console.log(`Compensation pool: ${formatEther(compensationAfterDex)} BNB`);
    console.log("All transactions above existed only in the in-memory fork.");
  } finally {
    await connection.close();
  }
}

await main();
