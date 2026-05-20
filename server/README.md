# Lawbworld Server

Express REST API that backs the Lawbworld 3D city. Mirrors `gitlawb.com/node` data, generates the deterministic 250-building repo pool, persists mint / upgrade / arcade state to a JSON file, and serves the frontend.

## Quickstart

```bash
cd server
npm install
cp .env.example .env
npm start
```

Server boots on `http://localhost:3001`. Open it in a browser — the frontend (`index.html` at repo root) is served from `/` and will auto-detect the API (look for the green `API · LIVE` badge in the topbar).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET  | `/api/health` | Liveness + version |
| GET  | `/api/stats` | Global counts (mints, upgrades, ETH raised, rarity distribution) |
| GET  | `/api/repos` | All 250 deterministic repos |
| GET  | `/api/repos/:did/:name` | Single repo detail |
| POST | `/api/mint` | Body: `{ fullId, walletAddress, txHash }` — `409` if already minted |
| POST | `/api/upgrade` | Body: `{ fullId, walletAddress }` — checks owner, level cap, $LAWB balance |
| GET  | `/api/leaderboard?limit=50` | Top buildings by rarity score + level + stars |
| GET  | `/api/peers` | Mirrors `gitlawb.com/node/peers` shape |
| GET  | `/api/wallet/:address` | Wallet $LAWB balance + owned tokens |
| GET  | `/api/wallet/:address/buildings` | Buildings owned by wallet |
| POST | `/api/arcade/score` | Body: `{ walletAddress, score }` |
| GET  | `/api/arcade/leaderboard` | Top arcade scores |
| POST | `/api/dev/grant` | Dev-only $LAWB grant (disabled when `NODE_ENV=production`) |

## State

Persisted to `./data/state.json` (debounced 250ms). Structure:

```jsonc
{
  "mints":       { "<fullId>": { tokenId, owner, txHash, level, mintedAt } },
  "wallets":     { "<addr>": { lawbBalance, ownedTokens: [tokenId, ...] } },
  "arcadeScores":[ { wallet, score, ts } ],
  "globalStats": { totalEthRaised, totalUpgrades }
}
```

Delete `data/state.json` to reset.

The repo pool itself is regenerated from a fixed seed on every boot (so `data/repos.json` is just a debug snapshot — safe to delete).

## Determinism

Frontend and server share the same FNV-1a hash + xorshift32 RNG and the same 250-slot tier distribution (10 Legendary / 50 Epic / 100 Rare / 60 Uncommon / 30 Common). Token IDs and file sizes match across both layers without coordination.
