# SITE56 FAC-remediation candidate

This directory contains the isolated, not-deployed SITE56 contract candidate prepared for public GitHub publication and external Flap/auditor review.

Important:

- It is not the source deployed at the old Factory `0xd844e76f99278e2d51C8A5eb7244e06C818B2fA4`.
- No replacement Factory or SITE56 token has been deployed.
- Do not insert private keys, mnemonic phrases, RPC API keys, `.env` files, keystores or deployment credentials into the public repository.
- Imported `src/flap` base contracts are canonical integration sources and must not be changed silently.

Validation commands:

```text
npm ci
npm run typecheck
npm test
forge test -vv
forge coverage --report summary
forge build --sizes
```

The mainnet-fork script requires a private archive-capable BSC RPC configured locally. Never commit that endpoint or its key.

Internal audit, application and operational materials are intentionally maintained outside this public source repository.
