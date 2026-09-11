# SITE56 deployed source and tests

This repository publishes the SITE56 CityVault system source and its tests. It matches the source used by the deployed BSC mainnet Factory `0xd844e76f99278e2d51C8A5eb7244e06C818B2fA4`.

Important:

- The SITE56 token has not been launched at the time of this source refresh.
- The launch uses Flap VaultPortal, the deployed Factory above, and a `0.5 BNB` creator initial buy.
- This project has not received Flap FAC approval or an independent third-party audit.
- Do not insert private keys, mnemonic phrases, RPC API keys, `.env` files, keystores or deployment credentials into the public repository.
- Imported `src/flap` base contracts are canonical integration sources and must not be changed silently.

Validation commands:

```text
npm ci
npm run typecheck
npm test
forge build --sizes
```

The mainnet-fork script requires a private archive-capable BSC RPC configured locally. Never commit that endpoint or its key.

Internal audit, application and operational materials are intentionally maintained outside this public source repository.
