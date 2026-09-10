import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseEther,
  zeroAddress,
} from "viem";

const connection = await network.create({
  network: "hardhat",
  override: { chainId: 97 },
});
const { viem, networkHelpers } = connection;

const TESTNET_VAULT_PORTAL =
  "0x027e3704fc5c16522e9393d04c60a3ac5c0d775f" as const;
const DISPATCH_THRESHOLD = parseEther("0.25");
const NO_CAPTURE_DELAY = 0n;

const validationPayloadType = [
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
] as const;

type LooseContract = any;
type LooseWallet = any;

type ValidationData = {
  tokenVersion: number;
  quoteToken: `0x${string}`;
  buyTaxRate: number;
  sellTaxRate: number;
  vaultBps: number;
  deflationBps: number;
  dividendBps: number;
  lpBps: number;
  dividendToken: `0x${string}`;
  minimumShareBalance: bigint;
};

const validLaunch: ValidationData = {
  tokenVersion: 6,
  quoteToken: zeroAddress,
  buyTaxRate: 300,
  sellTaxRate: 300,
  vaultBps: 10_000,
  deflationBps: 0,
  dividendBps: 0,
  lpBps: 0,
  dividendToken: zeroAddress,
  minimumShareBalance: 0n,
};

function encodeValidation(overrides: Partial<ValidationData> = {}) {
  return encodeAbiParameters(validationPayloadType, [
    { ...validLaunch, ...overrides },
  ]);
}

function encodeVaultData(
  treasury: `0x${string}`,
  threshold = DISPATCH_THRESHOLD,
  legacyDelay = NO_CAPTURE_DELAY,
) {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [treasury, threshold, legacyDelay],
  );
}

async function asWallet(
  contractName: string,
  address: `0x${string}`,
  wallet: LooseWallet,
): Promise<LooseContract> {
  return viem.getContractAt(contractName, address, {
    client: { wallet },
  }) as Promise<LooseContract>;
}

async function deployFixture() {
  const publicClient = await viem.getPublicClient();
  const [deployer, treasury, creator, outsider] =
    await viem.getWalletClients();

  assert.equal(await publicClient.getChainId(), 97);

  const token = (await viem.deployContract("MockERC20")) as LooseContract;
  const factory = (await viem.deployContract(
    "CityVaultFactory",
  )) as LooseContract;

  await networkHelpers.impersonateAccount(TESTNET_VAULT_PORTAL);
  await networkHelpers.setBalance(
    TESTNET_VAULT_PORTAL,
    parseEther("10"),
  );
  const portal = await viem.getWalletClient(TESTNET_VAULT_PORTAL);
  const portalFactory = await asWallet(
    "CityVaultFactory",
    factory.address,
    portal,
  );

  return {
    publicClient,
    deployer,
    treasury,
    creator,
    outsider,
    token,
    factory,
    portalFactory,
  };
}

async function readValidation(
  factory: LooseContract,
  overrides: Partial<ValidationData> = {},
) {
  const result = (await factory.read.onBeforeLaunch([
    encodeValidation(overrides),
  ])) as readonly [boolean, string];
  return { success: result[0], reason: result[1] };
}

describe("CityVaultFactory", { concurrency: false }, function () {
  it("publishes the three-field vault schema and ten wrapper-field policies", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);

    assert.equal(await factory.read.factorySpecVersion(), "v2.2");
    assert.equal(
      await factory.read.NO_CAPTURE_DELAY(),
      NO_CAPTURE_DELAY,
    );
    assert.equal(await factory.read.isQuoteTokenSupported([zeroAddress]), true);
    assert.equal(
      await factory.read.isQuoteTokenSupported([
        "0x0000000000000000000000000000000000000001",
      ]),
      false,
    );

    const schema = (await factory.read.vaultDataSchema()) as any;
    assert.equal(schema.fields.length, 3);
    assert.deepEqual(
      schema.fields.map((field: any) => field.name),
      [
        "treasury",
        "dispatchThreshold",
        "captureCooldown",
      ],
    );
    assert.equal(schema.fields[1].fieldType, "uint256");
    assert.equal(Number(schema.fields[1].decimals), 18);
    assert.match(schema.fields[1].description, /frozen before launch/);
    assert.equal(schema.fields[2].fieldType, "uint256");
    assert.match(schema.fields[2].description, /must be 0.*immediate/i);
    assert.equal(schema.isArray, false);

    const policies = (await factory.read.tokenCreationPolicies()) as any[];
    assert.equal(policies.length, 10);
    assert.deepEqual(
      policies.map((policy) => policy.target),
      [
        "tokenVersion",
        "quoteToken",
        "buyTaxRate",
        "sellTaxRate",
        "mktBps",
        "deflationBps",
        "dividendBps",
        "lpBps",
        "minimumShareBalance",
        "dividendToken",
      ],
    );
    assert.equal(policies.some((policy) => policy.target === "vaultBps"), false);
    assert.equal(
      decodeAbiParameters([{ type: "uint16" }], policies[4].value)[0],
      10_000,
    );
  });

  it("lets the chain-97 canonical VaultPortal deploy a vault with exact constructor values", async function () {
    const {
      publicClient,
      treasury,
      creator,
      token,
      factory,
      portalFactory,
    } = await networkHelpers.loadFixture(deployFixture);
    const vaultData = encodeVaultData(treasury.account.address);

    const simulation = await portalFactory.simulate.newVault([
      token.address,
      zeroAddress,
      creator.account.address,
      vaultData,
    ], { account: TESTNET_VAULT_PORTAL });
    const vaultAddress = simulation.result as `0x${string}`;
    await portalFactory.write.newVault([
      token.address,
      zeroAddress,
      creator.account.address,
      vaultData,
    ]);

    assert.notEqual(await publicClient.getBytecode({ address: vaultAddress }), undefined);
    const vault = (await viem.getContractAt(
      "CityVault",
      vaultAddress,
    )) as LooseContract;
    assert.equal(
      (await vault.read.taxToken()).toLowerCase(),
      token.address.toLowerCase(),
    );
    assert.equal(
      (await vault.read.creator()).toLowerCase(),
      creator.account.address.toLowerCase(),
    );
    assert.equal(
      (await vault.read.treasury()).toLowerCase(),
      treasury.account.address.toLowerCase(),
    );
    assert.equal(await vault.read.dispatchThreshold(), DISPATCH_THRESHOLD);
    assert.equal(await vault.read.captureCooldown(), NO_CAPTURE_DELAY);

    const deployerAddress = (await factory.read.vaultDeployer()) as `0x${string}`;
    assert.notEqual(
      await publicClient.getBytecode({ address: deployerAddress }),
      undefined,
    );
  });

  it("rejects non-Portal callers and non-native quote tokens", async function () {
    const {
      deployer,
      treasury,
      creator,
      token,
      factory,
      portalFactory,
    } = await networkHelpers.loadFixture(deployFixture);
    const vaultData = encodeVaultData(treasury.account.address);
    const deployerFactory = await asWallet(
      "CityVaultFactory",
      factory.address,
      deployer,
    );

    await viem.assertions.revertWith(
      deployerFactory.write.newVault([
        token.address,
        zeroAddress,
        creator.account.address,
        vaultData,
      ]),
      "Only VaultPortal",
    );
    await viem.assertions.revertWith(
      portalFactory.write.newVault([
        token.address,
        creator.account.address,
        creator.account.address,
        vaultData,
      ]),
      "Native BNB quote only",
    );
  });

  it("rejects every zero address in the factory input", async function () {
    const { treasury, creator, token, factory, portalFactory } =
      await networkHelpers.loadFixture(deployFixture);

    const calls = [
      () => portalFactory.write.newVault([
        zeroAddress,
        zeroAddress,
        creator.account.address,
        encodeVaultData(treasury.account.address),
      ]),
      () => portalFactory.write.newVault([
        token.address,
        zeroAddress,
        zeroAddress,
        encodeVaultData(treasury.account.address),
      ]),
      () => portalFactory.write.newVault([
        token.address,
        zeroAddress,
        creator.account.address,
        encodeVaultData(zeroAddress),
      ]),
    ];

    for (const call of calls) {
      await viem.assertions.revertWith(
        call(),
        "Zero address",
      );
    }
  });

  it("requires a nonzero threshold and a zero legacy capture-delay field", async function () {
    const { treasury, creator, token, factory, portalFactory } =
      await networkHelpers.loadFixture(deployFixture);
    const args = (
      threshold: bigint,
      legacyDelay: bigint,
    ) => [
      token.address,
      zeroAddress,
      creator.account.address,
      encodeVaultData(
        treasury.account.address,
        threshold,
        legacyDelay,
      ),
    ] as const;

    await viem.assertions.revertWith(
      portalFactory.write.newVault(args(0n, NO_CAPTURE_DELAY)),
      "Invalid dispatch threshold",
    );
    await viem.assertions.revertWith(
      portalFactory.write.newVault(args(DISPATCH_THRESHOLD, 1n)),
      "Capture delay must be zero",
    );
    await viem.assertions.revertWith(
      portalFactory.write.newVault(args(DISPATCH_THRESHOLD, 1n << 64n)),
      "Capture delay must be zero",
    );
  });

  it("accepts the exact normalized v2.2 launch configuration", async function () {
    const { factory } = await networkHelpers.loadFixture(deployFixture);
    assert.deepEqual(await readValidation(factory), {
      success: true,
      reason: "",
    });
  });

  it("rejects each of the ten normalized launch constraints independently", async function () {
    const { creator, factory } =
      await networkHelpers.loadFixture(deployFixture);
    const invalidCases: Array<{
      overrides: Partial<ValidationData>;
      reason: string;
    }> = [
      {
        overrides: { tokenVersion: 5 },
        reason: "CityVault requires TOKEN_TAXED_V3.",
      },
      {
        overrides: { quoteToken: creator.account.address },
        reason: "CityVault supports native BNB only.",
      },
      {
        overrides: { buyTaxRate: 299 },
        reason: "CityVault requires a 3% buy tax.",
      },
      {
        overrides: { sellTaxRate: 301 },
        reason: "CityVault requires a 3% sell tax.",
      },
      {
        // FactoryPolicy targets the V6 wrapper field `mktBps`; the normalized
        // v2.2 validation payload deliberately exposes the same value as
        // `vaultBps`.
        overrides: { vaultBps: 9_999 },
        reason:
          "CityVault requires 100% of collected tax to be allocated to the vault.",
      },
      {
        overrides: { deflationBps: 1 },
        reason: "CityVault requires deflationBps to be zero.",
      },
      {
        overrides: { dividendBps: 1 },
        reason: "CityVault requires dividendBps to be zero.",
      },
      {
        overrides: { lpBps: 1 },
        reason: "CityVault requires lpBps to be zero.",
      },
      {
        overrides: { minimumShareBalance: 1n },
        reason: "CityVault requires minimumShareBalance to be zero.",
      },
      {
        overrides: { dividendToken: creator.account.address },
        reason: "CityVault requires dividendToken to be native BNB.",
      },
    ];

    for (const invalidCase of invalidCases) {
      assert.deepEqual(
        await readValidation(factory, invalidCase.overrides),
        { success: false, reason: invalidCase.reason },
      );
    }
  });
});
