# Lawbworld Contracts

A single on-chain contract powers Lawbworld:

| Contract | Standard | Purpose |
|---|---|---|
| `LawbBuilding` | ERC-721 (UUPS upgradeable) | Each token = one minted gitlawb repo. Stores rarity, level, file size. Upgrades burn `$LAWBWORLD`. |

`$LAWBWORLD` itself is **not** deployed by this script — it is launched on the
**Bankr** launchpad. After the launchpad listing, call
`setLawbworldToken(<address>)` on the proxy as owner; until then, mint works
but upgrades revert with `LAWBLDG: token not set`.

Target chain: **Base** (mainnet `8453`, testnet `base-sepolia` `84532`). Solidity `0.8.24`.

## Quickstart

```bash
cd contracts
npm install
cp .env.example .env        # fill in PRIVATE_KEY + RPC + basescan key
npx hardhat compile
npx hardhat test
```

## Deploy

```bash
# testnet
npm run deploy:sepolia

# mainnet
npm run deploy:base
```

`scripts/deploy.js` deploys the UUPS proxy + `LawbBuilding` implementation and prints both addresses. After Bankr lists `$LAWBWORLD`, call:

```js
await proxy.setLawbworldToken("0x<lawbworld-token-address>");
```

Verify after deploy (verify the **implementation**, not the proxy):

```bash
npx hardhat verify --network base-sepolia <impl-address>
```

## Economics

- **Mint price**: `0.0003 ETH` (~$1 on Base, adjustable by owner via `setMintPrice`).
- **Upgrade cost**: `next_level × 25 $LAWBWORLD`, burned (1→2 costs 50, 2→3 costs 75, …, 9→10 costs 250). Total to fully upgrade: 1,475 LAWBWORLD.
- **Max level**: 10.

## Integration points

Frontend / server should call:

- `mint(repoId, rarity, fileSizeKB)` with `{ value: mintPrice }`.
- `upgrade(tokenId)` after the user has `approve`d the building contract on `$LAWBWORLD`.
- `isMinted(repoId)` / `repoToToken(keccak256(repoId))` to check availability.
- `getBuilding(tokenId)` for the full struct.

`repoId` convention: `"<did>/<name>"`, e.g. `"z6MkfWBnEx…/openclaw-v2"`.

## Upgradeability

`LawbBuilding` is UUPS (`_authorizeUpgrade` gated by `onlyOwner`). To roll out a new implementation:

```bash
npx hardhat run scripts/upgrade.js --network base
```

Storage layout is checked by `@openzeppelin/hardhat-upgrades` on every upgrade — never reorder existing state variables.

## Notes

- `keccak256` is used to key `repoToToken` so the mapping is gas-cheap.
- Upgrades use `burnFrom`, so users must `approve(building, amount)` first. Wrap this in a single button on the frontend (approve → upgrade).
- `tokenURI` is just `baseTokenURI + tokenId`. Point `baseTokenURI` at a metadata service (could be the Lawbworld server's own `/api/metadata/`).
