/**
 * LAWBWORLD — Backend Server
 *
 * Express REST API that:
 *   - serves the static frontend (index.html)
 *   - fetches the live repo index from gitlawb.com/node/repos (all 2566 repos)
 *     and caches it to data/repos.json, refreshed every REPO_REFRESH_MIN minutes
 *   - persists mint/upgrade state to data/state.json
 *   - exposes /api endpoints consumed by the frontend
 *   - proxies AI image / city-layout generation via OpenRouter
 *
 * Run:
 *   npm install
 *   npm start        (http://localhost:3001)
 */

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ethers = require("ethers");

const PORT          = parseInt(process.env.PORT || "3001", 10);
const HOST          = process.env.HOST || "0.0.0.0";
const DATA_DIR      = path.join(__dirname, "data");
const STATE_FILE    = path.join(DATA_DIR, "state.json");
const REPOS_FILE    = path.join(DATA_DIR, "repos.json");
const SEED_REPOS_FILE = path.join(DATA_DIR, "repos.seed.json");
const GITLAWB_BASE  = (process.env.GITLAWB_BASE || "https://gitlawb.com").replace(/\/+$/, "");
const REPO_REFRESH_MIN = parseInt(process.env.REPO_REFRESH_MIN || "10", 10);
const REPO_FETCH_TIMEOUT_MS = parseInt(process.env.REPO_FETCH_TIMEOUT_MS || "20000", 10);
const MINT_PRICE_ETH = 0.0003;
const LAWB_INITIAL  = 128;
const UPGRADE_BASE_COST = 25;

const CHAIN_ID            = parseInt(process.env.CHAIN_ID || "84532", 10);
const CHAIN_RPC           = (process.env.CHAIN_RPC || "https://base-sepolia.publicnode.com").trim();
const LAWB_BUILDING_PROXY = (process.env.LAWB_BUILDING_PROXY || "").trim();
const MINT_SIGNER_KEY     = (process.env.MINT_SIGNER_KEY || "").trim();
const MINT_SIG_TTL_SEC    = parseInt(process.env.MINT_SIG_TTL_SEC || "600", 10);
const INDEXER_FROM_BLOCK  = parseInt(process.env.INDEXER_FROM_BLOCK || "0", 10);
const INDEXER_POLL_MS     = parseInt(process.env.INDEXER_POLL_MS || "30000", 10);

let _signerWallet = null;
function getSignerWallet() {
  if (!MINT_SIGNER_KEY || !ethers.isHexString(MINT_SIGNER_KEY, 32)) return null;
  if (!_signerWallet) _signerWallet = new ethers.Wallet(MINT_SIGNER_KEY);
  return _signerWallet;
}

const INDEXER_ABI = [
  "event Minted(uint256 indexed tokenId,address indexed owner,string repoId,uint8 rarity,uint32 fileSizeKB)",
  "event LevelUp(uint256 indexed tokenId,uint8 newLevel,uint256 lawbBurned)",
];
let _onchainProvider = null;
let _onchainContract = null;
let _indexedToBlock  = 0;
let _indexerRunning  = false;

function indexerReady() {
  return !!(LAWB_BUILDING_PROXY && CHAIN_RPC);
}

function getOnchainContract() {
  if (_onchainContract) return _onchainContract;
  if (!indexerReady()) return null;
  _onchainProvider = new ethers.JsonRpcProvider(CHAIN_RPC, CHAIN_ID);
  _onchainContract = new ethers.Contract(LAWB_BUILDING_PROXY, INDEXER_ABI, _onchainProvider);
  return _onchainContract;
}

async function indexFromChain() {
  if (_indexerRunning) return;
  const c = getOnchainContract();
  if (!c) return;
  _indexerRunning = true;
  try {
    const latest = await _onchainProvider.getBlockNumber();
    const LOOKBACK = 500000;
    let startBlock = Math.max(_indexedToBlock + 1, INDEXER_FROM_BLOCK);
    if (_indexedToBlock === 0 && INDEXER_FROM_BLOCK === 0) {
      startBlock = Math.max(0, latest - LOOKBACK);
      console.log(`[indexer] first run — scanning last ${LOOKBACK} blocks (from ${startBlock} to ${latest})`);
    }
    if (startBlock > latest) { _indexerRunning = false; return; }

    const CHUNK = 9990;
    let totalMint = 0, totalLevel = 0;
    let chunkFailures = 0;
    for (let from = startBlock; from <= latest; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, latest);
      try {
        const mintLogs  = await c.queryFilter(c.filters.Minted(),  from, to);
        const levelLogs = await c.queryFilter(c.filters.LevelUp(), from, to);
        for (const log of mintLogs) {
          const repoId = log.args.repoId;
          const owner  = log.args.owner.toLowerCase();
          const tokenId = Number(log.args.tokenId);
          const existing = STATE.mints[repoId] || {};
          STATE.mints[repoId] = {
            owner,
            level: existing.level || 1,
            mintedAt: existing.mintedAt || Date.now(),
            txHash: log.transactionHash,
            tokenId,
            rarity: existing.rarity || Number(log.args.rarity),
            rarityTier: Number(log.args.rarity),
          };
          totalMint++;
        }
        for (const log of levelLogs) {
          const tokenId = Number(log.args.tokenId);
          const newLevel = Number(log.args.newLevel);
          for (const m of Object.values(STATE.mints)) {
            if (m.tokenId === tokenId) { m.level = newLevel; break; }
          }
          totalLevel++;
        }
        _indexedToBlock = to;
      } catch (err) {
        chunkFailures++;
        if (chunkFailures <= 3) {
          console.warn(`[indexer] chunk ${from}-${to} failed:`, (err.shortMessage || err.message || "").slice(0, 80));
        }
        if (chunkFailures > 25) {
          console.warn(`[indexer] too many failures, stopping at block ${_indexedToBlock}`);
          break;
        }
      }
    }
    _indexedToBlock = Math.max(_indexedToBlock, latest);
    STATE.indexedToBlock = latest;
    if (totalMint || totalLevel) {
      console.log(`[indexer] synced to block ${latest} · +${totalMint} mints · +${totalLevel} level-ups`);
    }
    saveState();
  } catch (e) {
    console.warn("[indexer] failed:", e.shortMessage || e.message);
  } finally {
    _indexerRunning = false;
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE    = "https://openrouter.ai/api/v1";
const OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-2.5-flash-image-preview";
const OPENROUTER_TEXT_MODEL  = process.env.OPENROUTER_TEXT_MODEL  || "anthropic/claude-sonnet-4";
const OPENROUTER_SITE_URL    = process.env.OPENROUTER_SITE_URL    || "https://lawbworld.local";
const OPENROUTER_APP_NAME    = process.env.OPENROUTER_APP_NAME    || "Lawbworld";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ART_DIR        = path.join(DATA_DIR, "art");
const ART_BUILD_DIR  = path.join(ART_DIR, "buildings");
const ART_TOWER_DIR  = path.join(ART_DIR, "towers");
let ART_INDEX = { buildings: { common: [], uncommon: [], rare: [], epic: [], legendary: [] }, towers: [] };
let ART_INDEX_AT = 0;

function refreshArtIndex({ maxAgeMs = 10000 } = {}) {
  if (Date.now() - ART_INDEX_AT < maxAgeMs) return ART_INDEX;
  const next = { buildings: { common: [], uncommon: [], rare: [], epic: [], legendary: [] }, towers: [] };
  for (const tier of Object.keys(next.buildings)) {
    const dir = path.join(ART_BUILD_DIR, tier);
    if (fs.existsSync(dir)) {
      next.buildings[tier] = fs.readdirSync(dir)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .sort()
        .map(f => `/assets/art/buildings/${tier}/${f}`);
    }
  }
  if (fs.existsSync(ART_TOWER_DIR)) {
    next.towers = fs.readdirSync(ART_TOWER_DIR)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort()
      .map(f => `/assets/art/towers/${f}`);
  }
  ART_INDEX = next;
  ART_INDEX_AT = Date.now();
  return ART_INDEX;
}

function artUrlForRepo(repo) {
  const tier = (repo.rarity || "common").toLowerCase();
  const pool = ART_INDEX.buildings[tier] || [];
  if (!pool.length) return null;
  return pool[(repo.seed >>> 0) % pool.length];
}

function thumbUrlFor(artUrl, size = 256) {
  if (!artUrl) return null;
  return artUrl.replace("/assets/art/", `/assets/art-thumb/${size}/`);
}
function cutoutUrlFor(artUrl, size = 256) {
  if (!artUrl) return null;
  return artUrl.replace("/assets/art/", `/assets/art-cutout/${size}/`);
}

const RARITY = [
  { tier: 0, name: "COMMON",    color: "#5b6478", sizeMin: 1,    sizeMax: 49 },
  { tier: 1, name: "UNCOMMON",  color: "#34d399", sizeMin: 50,   sizeMax: 199 },
  { tier: 2, name: "RARE",      color: "#38bdf8", sizeMin: 200,  sizeMax: 499 },
  { tier: 3, name: "EPIC",      color: "#c084fc", sizeMin: 500,  sizeMax: 1999 },
  { tier: 4, name: "LEGENDARY", color: "#fbbf24", sizeMin: 2000, sizeMax: 80000 },
];

const RARITY_WEIGHTS = [
  { tier: 4, weight: 0.03 },
  { tier: 3, weight: 0.08 },
  { tier: 2, weight: 0.17 },
  { tier: 1, weight: 0.27 },
  { tier: 0, weight: 0.45 },
];

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function rngFromSeed(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967295;
  };
}

const SEED_REPOS = [
  ["z6MkoS9e","honey-router","OpenAI-compatible router. Routes requests to multiple LLM providers via signed gitlawb capabilities."],
  ["z6Mki9mn","mirror-test","Peer-mirror correctness test repo."],
  ["z6Mki9mn","starfield","Starfield background renderer in pure WebGL."],
  ["z6Mki9mn","pie-terminal-display","Terminal-based pie chart renderer with unicode shading."],
  ["z6Mki9mn","moss-lang","Experimental scripting language."],
  ["z6Mki9mn","MiroFish","Collaborative whiteboard prototype."],
  ["z6Mkm4Cj","playground-neartoilets-v1vpco","Playground scratch repo."],
  ["z6MkoK2n","playground-clawvatar-e5cfja","Clawvatar generator demo."],
  ["z6MktKZe","e2e-test-repo","End-to-end test fixture."],
  ["z6MkwbuduC","nipmod","Reference NIP modifier set."],
  ["z6MkpbZk","pyxis","Mirrored from https://github.com/pyxis-app/pyxis"],
  ["z6Mkw1ZZ","KnowledgeBase","Global Knowledge Base — synthesized creative tech, design, and project knowledge"],
  ["z6Mkw1ZZ","daseinduniya","Hyperbolic non-Euclidean engine for Dasein Lab"],
];

const DANGEROUS_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?(\.|\/|$)/i,
  /(^|\/)credentials?(\.|\/|$)/i,
  /(^|\/)private[-_]?key/i,
  /(^|\/)id_rsa(\.|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/).*[._-]secret[._-]?/i,
  /(^|\/).*[._-]token[._-]?/i,
  /(^|\/).*[._-]password[._-]?/i,
];

function isDangerousRepoName(name) {
  if (!name) return false;
  return DANGEROUS_PATTERNS.some((re) => re.test(name));
}

function parseGitlawbHtml(html) {
  const seen = new Set();
  const repos = [];

  const re = /href="\/node\/repos\/([A-Za-z0-9_-]+)\/([^"#?\s]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const did = m[1];
    const name = decodeURIComponent(m[2]);
    if (!did.startsWith("z6Mk")) continue;
    if (name.length > 200) continue;
    if (isDangerousRepoName(name)) continue;
    const key = `${did}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tail = html.slice(m.index, m.index + 600);
    const descMatch =
      tail.match(/Description:\s*"([^"]{2,300})"/i) ||
      tail.match(/<p[^>]*class="[^"]*desc[^"]*"[^>]*>([^<]{2,300})<\/p>/i) ||
      tail.match(/Mirrored from [^<\n"]{2,200}/i);
    const desc = descMatch
      ? (descMatch[1] || descMatch[0]).replace(/\s+/g, " ").trim()
      : "Federated repository hosted on gitlawb p2p mirrors.";

    repos.push({ did, name, desc, real: true });
  }
  return repos;
}

async function fetchWithTimeout(url, ms) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (node 18+ required)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "lawbworld-server/0.3 (+https://lawbworld.local)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllRepos() {
  const firstUrl = `${GITLAWB_BASE}/node/repos?page=1&per_page=50`;
  const firstHtml = await fetchWithTimeout(firstUrl, REPO_FETCH_TIMEOUT_MS);
  const totalRepos = (() => {
    const m = firstHtml.match(/(\d[\d,]{2,})\s*repos/i);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
  })();
  const lastPage = totalRepos ? Math.ceil(totalRepos / 50) : 120;

  const all = new Map();
  for (const r of parseGitlawbHtml(firstHtml)) all.set(`${r.did}/${r.name}`, r);
  console.log(`[sync] page 1: ${all.size} (totalRepos≈${totalRepos || "?"}, lastPage=${lastPage})`);

  const CONCURRENCY = 8;
  for (let start = 2; start <= lastPage; start += CONCURRENCY) {
    const batch = [];
    for (let p = start; p < start + CONCURRENCY && p <= lastPage; p++) {
      const url = `${GITLAWB_BASE}/node/repos?page=${p}&per_page=50`;
      batch.push(
        fetchWithTimeout(url, REPO_FETCH_TIMEOUT_MS)
          .then(html => ({ p, repos: parseGitlawbHtml(html) }))
          .catch(e   => ({ p, repos: [], err: e.message }))
      );
    }
    const results = await Promise.all(batch);
    let batchAdded = 0;
    for (const { p, repos, err } of results) {
      if (err) { console.warn(`[sync] page ${p} failed: ${err}`); continue; }
      for (const r of repos) {
        const k = `${r.did}/${r.name}`;
        if (!all.has(k)) { all.set(k, r); batchAdded++; }
      }
    }
    console.log(`[sync] pages ${start}-${Math.min(start+CONCURRENCY-1,lastPage)}: +${batchAdded} (total ${all.size})`);
    if (batchAdded === 0) break;
  }
  return Array.from(all.values());
}

function decorateRepos(pool) {
  if (!pool.length) return [];

  pool.sort((a, b) => hashStr(a.did + "/" + a.name) - hashStr(b.did + "/" + b.name));

  const total = pool.length;
  const counts = RARITY_WEIGHTS.map(w => Math.round(w.weight * total));
  let drift = total - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; drift !== 0; i = (i + 1) % counts.length) {
    counts[i] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
  }

  const repos = [];
  let cursor = 0;
  RARITY_WEIGHTS.forEach((bucket, idx) => {
    for (let i = 0; i < counts[idx]; i++) {
      if (cursor >= pool.length) break;
      const p = pool[cursor++];
      repos.push(makeRepoInTier(p.did, p.name, p.desc || "Federated repository hosted on gitlawb p2p mirrors.", true, bucket.tier));
    }
  });
  return repos;
}

function makeRepoInTier(did, name, desc, real, tier) {
  const fullId = `${did}/${name}`;
  const h = hashStr(fullId);
  const rng = rngFromSeed(h);
  const r = RARITY[tier];
  const fileSizeKB = r.sizeMin + Math.floor(rng() * (r.sizeMax - r.sizeMin + 1));
  return {
    did,
    name,
    fullId,
    desc,
    real,
    fileSizeKB,
    rarity: r.name,
    rarityTier: r.tier,
    rarityColor: r.color,
    stars: Math.floor(rng() * (real ? 30 : 14)),
    visits: Math.floor(rng() * 200) + (real ? 50 : 5),
    commits: Math.floor(rng() * 200) + 3,
    seed: h,
    tokenId: 1000 + (h % 9000000),
  };
}

let STATE = {
  mints: {},
  wallets: {},
  arcadeScores: {},
  globalStats: { totalMints: 0, totalUpgrades: 0, totalEthRaised: 0 },
};
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      STATE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      STATE.mints ||= {};
      STATE.wallets ||= {};
      STATE.arcadeScores ||= {};
      STATE.globalStats ||= { totalMints: 0, totalUpgrades: 0, totalEthRaised: 0 };
      _indexedToBlock = STATE.indexedToBlock || 0;
      console.log(`[state] loaded — ${Object.keys(STATE.mints).length} mints, ${Object.keys(STATE.wallets).length} wallets, indexedBlock=${_indexedToBlock}`);
    } catch (e) {
      console.warn("[state] failed to parse, starting fresh:", e.message);
    }
  } else {
    console.log("[state] no state file — starting fresh");
  }
}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(STATE, null, 2), (err) => {
      if (err) console.error("[state] save error:", err);
    });
  }, 250);
}

function getOrCreateWallet(address) {
  if (!STATE.wallets[address]) {
    STATE.wallets[address] = { lawb: LAWB_INITIAL, eth: 0, mintedTokenIds: [] };
  }
  return STATE.wallets[address];
}

let REPOS = [];
let REPOS_LAST_SYNCED_AT = 0;
let REPOS_SOURCE = "seed";

function repoCacheSummary() {
  const tiers = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  REPOS.forEach((r) => tiers[r.rarityTier]++);
  return {
    total: REPOS.length,
    source: REPOS_SOURCE,
    lastSyncedAt: REPOS_LAST_SYNCED_AT,
    rarityCounts: {
      COMMON: tiers[0], UNCOMMON: tiers[1], RARE: tiers[2], EPIC: tiers[3], LEGENDARY: tiers[4],
    },
  };
}

function reposWithMintState() {
  refreshArtIndex();
  return REPOS.map((r) => {
    const m = STATE.mints[r.fullId];
    const artUrl = artUrlForRepo(r);
    return {
      ...r,
      artUrl,
      artThumbUrl:  thumbUrlFor(artUrl, 128),
      artCityUrl:   thumbUrlFor(artUrl, 256),
      artSpriteUrl: cutoutUrlFor(artUrl, 256),
      minted: !!m,
      owner: m ? m.owner : null,
      level: m ? m.level : 1,
      mintedAt: m ? m.mintedAt : null,
      imageUrl: (m && m.imageUrl) || artUrl,
    };
  });
}

function writeReposToDisk() {
  try {
    fs.writeFileSync(REPOS_FILE, JSON.stringify({
      syncedAt: REPOS_LAST_SYNCED_AT,
      source: REPOS_SOURCE,
      total: REPOS.length,
      repos: REPOS,
    }, null, 0));
  } catch (e) {
    console.warn("[repos] write failed:", e.message);
  }
}

function loadReposFromDisk() {
  try {
    if (!fs.existsSync(REPOS_FILE)) return false;
    const obj = JSON.parse(fs.readFileSync(REPOS_FILE, "utf8"));
    if (!obj || !Array.isArray(obj.repos) || !obj.repos.length) return false;
    REPOS = obj.repos;
    REPOS_LAST_SYNCED_AT = obj.syncedAt || 0;
    REPOS_SOURCE = (obj.source || "cache") + "+disk";
    console.log(`[repos] loaded ${REPOS.length} repos from disk (source=${obj.source}, age=${Math.round((Date.now()-REPOS_LAST_SYNCED_AT)/1000)}s)`);
    return true;
  } catch (e) {
    console.warn("[repos] disk load failed:", e.message);
    return false;
  }
}

async function refreshRepoIndex({ force = false } = {}) {
  const ageMin = (Date.now() - REPOS_LAST_SYNCED_AT) / 60000;
  if (!force && REPOS.length && ageMin < REPO_REFRESH_MIN) return REPOS.length;
  try {
    console.log(`[sync] fetching live repo index from ${GITLAWB_BASE}/node/repos ...`);
    const live = await fetchAllRepos();
    if (live.length >= 50) {
      REPOS = decorateRepos(live);
      REPOS_LAST_SYNCED_AT = Date.now();
      REPOS_SOURCE = "gitlawb-live";
      writeReposToDisk();
      console.log(`[sync] OK — ${REPOS.length} buildings generated from ${live.length} live repos`);
      return REPOS.length;
    }
    console.warn(`[sync] live returned ${live.length} repos, keeping previous cache`);
  } catch (e) {
    console.warn(`[sync] failed: ${e.message}`);
  }
  if (!REPOS.length) {
    const seed = SEED_REPOS.map(r => ({ did: r[0], name: r[1], desc: r[2], real: true }));
    REPOS = decorateRepos(seed);
    REPOS_LAST_SYNCED_AT = Date.now();
    REPOS_SOURCE = "seed";
    writeReposToDisk();
    console.log(`[sync] using seed pool (${REPOS.length} buildings)`);
  }
  return REPOS.length;
}

async function openrouterChat({ model, messages, max_tokens = 1024, temperature = 0.7, response_format }) {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
  const body = { model: model || OPENROUTER_TEXT_MODEL, messages, max_tokens, temperature };
  if (response_format) body.response_format = response_format;
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": OPENROUTER_SITE_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 240)}`);
  }
  return res.json();
}

async function openrouterImage({ model, prompt, size = "1024x1024" }) {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": OPENROUTER_SITE_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
    body: JSON.stringify({
      model: model || OPENROUTER_IMAGE_MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
      extra_body: { size },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter image ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  let imageUrl = null;
  try {
    const msg = data?.choices?.[0]?.message;
    const contents = Array.isArray(msg?.content) ? msg.content : [];
    for (const c of contents) {
      if (c?.type === "image_url" && c.image_url?.url) { imageUrl = c.image_url.url; break; }
      if (c?.type === "image" && c.image?.url)         { imageUrl = c.image.url;     break; }
      if (typeof c?.image_url === "string")            { imageUrl = c.image_url;     break; }
    }
    if (!imageUrl) {
      const imgs = msg?.images || data?.images || [];
      if (Array.isArray(imgs) && imgs[0]) {
        imageUrl = imgs[0]?.image_url?.url || imgs[0]?.url || imgs[0];
      }
    }
  } catch (_) {}
  return { imageUrl, raw: data };
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/assets/art", express.static(ART_DIR, {
  fallthrough: true,
  maxAge: "1h",
  immutable: false,
}));

let sharp;
try { sharp = require("sharp"); } catch (_) { sharp = null; }
const THUMB_DIR = path.join(DATA_DIR, "art-thumb");
const CUTOUT_DIR = path.join(DATA_DIR, "art-cutout");

function badRel(rel){
  return rel.includes("..") || !/^[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp)$/i.test(rel);
}

app.get("/assets/art-thumb/:size/*", async (req, res) => {
  if (!sharp) return res.status(503).send("sharp not installed");
  const size = Math.min(parseInt(req.params.size, 10) || 256, 1024);
  const rel  = req.params[0];
  if (badRel(rel)) return res.status(400).send("bad path");
  const src = path.join(ART_DIR, rel);
  if (!fs.existsSync(src)) return res.status(404).send("not found");
  const cacheFile = path.join(THUMB_DIR, String(size), rel);
  if (fs.existsSync(cacheFile)) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(cacheFile);
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    await sharp(src).resize(size, size, { fit: "cover" }).png({ quality: 88 }).toFile(cacheFile);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(cacheFile);
  } catch (e) {
    res.status(500).send("resize failed: " + e.message);
  }
});

app.get("/assets/art-cutout/:size/*", async (req, res) => {
  if (!sharp) return res.status(503).send("sharp not installed");
  const size = Math.min(parseInt(req.params.size, 10) || 256, 1024);
  const rel  = req.params[0];
  if (badRel(rel)) return res.status(400).send("bad path");
  const src = path.join(ART_DIR, rel);
  if (!fs.existsSync(src)) return res.status(404).send("not found");
  const cacheFile = path.join(CUTOUT_DIR, String(size), rel);
  if (fs.existsSync(cacheFile)) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(cacheFile);
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const LUMA_CUT = 32;
    const LUMA_KEEP = 70;
    const { data, info } = await sharp(src)
      .resize(size, size, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    for (let i = 0; i < px; i++) {
      const o = i * 4;
      const r = data[o], g = data[o+1], b = data[o+2];
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (luma <= LUMA_CUT) data[o+3] = 0;
      else if (luma < LUMA_KEEP) {
        const t = (luma - LUMA_CUT) / (LUMA_KEEP - LUMA_CUT);
        data[o+3] = Math.round(t * 255);
      }
    }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(cacheFile);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(cacheFile);
  } catch (e) {
    res.status(500).send("cutout failed: " + e.message);
  }
});

app.use(express.static(path.join(__dirname, ".."), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

app.get("/api/art", (req, res) => {
  refreshArtIndex({ maxAgeMs: 0 });
  res.json({
    counts: {
      buildings: Object.fromEntries(Object.entries(ART_INDEX.buildings).map(([k, v]) => [k, v.length])),
      towers: ART_INDEX.towers.length,
    },
    art: ART_INDEX,
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "lawbworld-api",
    version: "0.4.0",
    repos: REPOS.length,
    repoSource: REPOS_SOURCE,
    repoSyncedAt: REPOS_LAST_SYNCED_AT,
    mints: Object.keys(STATE.mints).length,
    aiEnabled: !!OPENROUTER_API_KEY,
    uptimeSec: Math.floor(process.uptime()),
  });
});

app.get("/api/stats", (req, res) => {
  const sum = repoCacheSummary();
  res.json({
    totalRepos: sum.total,
    totalMints: Object.keys(STATE.mints).length,
    totalUpgrades: STATE.globalStats.totalUpgrades,
    totalEthRaised: STATE.globalStats.totalEthRaised,
    rarityCounts: sum.rarityCounts,
    source: sum.source,
    lastSyncedAt: sum.lastSyncedAt,
  });
});

app.get("/api/repos", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "5000", 10), 5000);
  const offset = Math.max(parseInt(req.query.offset || "0",    10), 0);
  const slice = reposWithMintState().slice(offset, offset + limit);
  res.json({
    repos: slice,
    total: REPOS.length,
    offset, limit,
    source: REPOS_SOURCE,
    syncedAt: REPOS_LAST_SYNCED_AT,
  });
});
app.get("/api/repos/:did/:name", (req, res) => {
  const fullId = `${req.params.did}/${req.params.name}`;
  const r = REPOS.find((x) => x.fullId === fullId);
  if (!r) return res.status(404).json({ ok: false, error: "not_found" });
  const m = STATE.mints[r.fullId];
  refreshArtIndex();
  const artUrl = artUrlForRepo(r);
  res.json({
    ok: true,
    repo: {
      ...r,
      artUrl,
      artThumbUrl:  thumbUrlFor(artUrl, 128),
      artCityUrl:   thumbUrlFor(artUrl, 256),
      artSpriteUrl: cutoutUrlFor(artUrl, 256),
      minted: !!m,
      owner: m ? m.owner : null,
      level: m ? m.level : 1,
      mintedAt: m ? m.mintedAt : null,
      txHash: m ? m.txHash : null,
      imageUrl: (m && m.imageUrl) || artUrl,
    },
  });
});

app.post("/api/repos/sync", async (req, res) => {
  const force = req.query.force === "1" || req.body?.force === true;
  try {
    const n = await refreshRepoIndex({ force });
    res.json({ ok: true, total: n, source: REPOS_SOURCE, lastSyncedAt: REPOS_LAST_SYNCED_AT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/indexer/status", (req, res) => {
  res.json({
    ok: true,
    enabled: indexerReady(),
    indexedToBlock: _indexedToBlock,
    mintsCount: Object.keys(STATE.mints).length,
    chainId: CHAIN_ID,
    proxy: LAWB_BUILDING_PROXY,
    rpc: CHAIN_RPC,
    running: _indexerRunning,
  });
});

app.post("/api/indexer/sync", async (req, res) => {
  if (!indexerReady()) return res.status(503).json({ ok: false, error: "indexer_disabled" });
  try {
    await indexFromChain();
    res.json({ ok: true, indexedToBlock: _indexedToBlock, mintsCount: Object.keys(STATE.mints).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/indexer/reset", async (req, res) => {
  if (!indexerReady()) return res.status(503).json({ ok: false, error: "indexer_disabled" });
  const before = Object.keys(STATE.mints).length;
  STATE.mints = {};
  STATE.indexedToBlock = 0;
  _indexedToBlock = 0;
  saveState();
  try {
    await indexFromChain();
    res.json({
      ok: true,
      cleared: before,
      reindexed: Object.keys(STATE.mints).length,
      indexedToBlock: _indexedToBlock,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/mint-sig/info", (req, res) => {
  const wallet = getSignerWallet();
  res.json({
    ok: true,
    chainId: CHAIN_ID,
    verifyingContract: LAWB_BUILDING_PROXY || null,
    signerAddress: wallet ? wallet.address : null,
    ready: !!(wallet && LAWB_BUILDING_PROXY),
    ttlSec: MINT_SIG_TTL_SEC,
    domain: { name: "Lawbworld", version: "1", chainId: CHAIN_ID, verifyingContract: LAWB_BUILDING_PROXY || null },
    types: {
      Mint: [
        { name: "to",         type: "address" },
        { name: "repoIdHash", type: "bytes32" },
        { name: "rarity",     type: "uint8"   },
        { name: "fileSizeKB", type: "uint32"  },
        { name: "deadline",   type: "uint256" },
      ],
    },
  });
});

app.post("/api/mint-sig", async (req, res) => {
  try {
    const wallet = getSignerWallet();
    if (!wallet) return res.status(503).json({ ok: false, error: "signer_not_configured", hint: "set MINT_SIGNER_KEY in server/.env" });
    if (!LAWB_BUILDING_PROXY) return res.status(503).json({ ok: false, error: "proxy_not_set", hint: "set LAWB_BUILDING_PROXY in server/.env" });

    const { fullId, walletAddress } = req.body || {};
    if (!fullId || !walletAddress) return res.status(400).json({ ok: false, error: "fullId and walletAddress required" });
    if (!ethers.isAddress(walletAddress)) return res.status(400).json({ ok: false, error: "bad wallet address" });

    const repo = REPOS.find(r => r.fullId === fullId);
    if (!repo) return res.status(404).json({ ok: false, error: "repo_not_found" });

    if (STATE.mints[fullId]) return res.status(409).json({ ok: false, error: "already_minted", owner: STATE.mints[fullId].owner });

    const tier = typeof repo.rarityTier === "number" ? repo.rarityTier : RARITY.findIndex(r => r.name === repo.rarity);
    if (tier < 0 || tier > 4) return res.status(500).json({ ok: false, error: "rarity_lookup_failed" });

    const fileSizeKB = Math.min(Math.max(repo.fileSizeKB | 0, 1), 0xFFFFFFFF);
    const deadline = Math.floor(Date.now() / 1000) + MINT_SIG_TTL_SEC;
    const to = ethers.getAddress(walletAddress);
    const repoIdHash = ethers.keccak256(ethers.toUtf8Bytes(fullId));

    const domain = { name: "Lawbworld", version: "1", chainId: CHAIN_ID, verifyingContract: LAWB_BUILDING_PROXY };
    const types  = {
      Mint: [
        { name: "to",         type: "address" },
        { name: "repoIdHash", type: "bytes32" },
        { name: "rarity",     type: "uint8"   },
        { name: "fileSizeKB", type: "uint32"  },
        { name: "deadline",   type: "uint256" },
      ],
    };
    const value = { to, repoIdHash, rarity: tier, fileSizeKB, deadline };
    const signature = await wallet.signTypedData(domain, types, value);

    res.json({
      ok: true,
      repoId: fullId,
      rarity: tier,
      fileSizeKB,
      deadline,
      signature,
      signerAddress: wallet.address,
      verifyingContract: LAWB_BUILDING_PROXY,
      chainId: CHAIN_ID,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/mint", async (req, res) => {
  const { fullId, walletAddress, txHash } = req.body || {};
  if (!fullId) return res.status(400).json({ ok: false, error: "fullId required" });
  const repo = REPOS.find((r) => r.fullId === fullId);
  if (!repo) return res.status(404).json({ ok: false, error: "repo_not_found" });

  if (indexerReady()) {
    try { await indexFromChain(); } catch (_) {}
  }

  const m = STATE.mints[fullId];
  if (m) {
    return res.json({
      ok: true,
      source: "onchain",
      fullId,
      owner: m.owner,
      level: m.level,
      tokenId: m.tokenId,
      rarity: m.rarity,
      mintedAt: m.mintedAt,
      txHash: m.txHash,
    });
  }
  res.json({
    ok: true,
    source: "pending",
    fullId,
    note: "indexer hasn't picked up the mint yet — retry /api/indexer/sync or wait 30s",
    txHash: txHash || null,
    walletAddress: walletAddress || null,
  });
});

app.post("/api/upgrade", (req, res) => {
  const { fullId, walletAddress } = req.body || {};
  if (!fullId || !walletAddress) {
    return res.status(400).json({ ok: false, error: "fullId and walletAddress required" });
  }
  const m = STATE.mints[fullId];
  if (!m) return res.status(404).json({ ok: false, error: "not_minted" });
  if (m.owner !== walletAddress) return res.status(403).json({ ok: false, error: "not_owner" });
  if (m.level >= 10) return res.status(400).json({ ok: false, error: "max_level" });
  const wallet = getOrCreateWallet(walletAddress);
  const cost = (m.level + 1) * UPGRADE_BASE_COST;
  if (wallet.lawb < cost) {
    return res.status(402).json({ ok: false, error: "insufficient_lawb", required: cost, balance: wallet.lawb });
  }
  wallet.lawb -= cost;
  m.level++;
  STATE.globalStats.totalUpgrades++;
  saveState();
  res.json({ ok: true, level: m.level, balance: wallet.lawb, cost });
});

app.get("/api/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const rows = REPOS.map((r) => {
    const m = STATE.mints[r.fullId];
    const level = m ? m.level : 1;
    const score = r.rarityTier * 1000 + level * 50 + r.stars * 3 + Math.log10(r.fileSizeKB + 1) * 8;
    return {
      fullId: r.fullId, name: r.name, did: r.did,
      rarity: r.rarity, rarityColor: r.rarityColor,
      level, stars: r.stars, fileSizeKB: r.fileSizeKB,
      minted: !!m, owner: m ? m.owner : null, score,
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  res.json({ rows });
});

const SEED_PEERS = [
  { did: "z6MknkD3ds", url: "https://your-node.example.com",          status: "unreachable", lastSeen: "4m ago" },
  { did: "z6MkiYSDKC", url: "https://node3.gitlawb.com",              status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MkrV8ktC", url: "https://node2.gitlawb.com",              status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MktERLyh", url: "https://rapybus-gitlawb.com",            status: "reachable",   lastSeen: "4m ago" },
  { did: "z6Mkw3zyzN", url: "https://node.nipmod.com",                status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MkuWaKiC", url: "http://localhost:7545",                  status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MkgVdj6V", url: "https://open-world.tail81e4ba.ts.net",   status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MkimP66h", url: "http://localhost:7545",                  status: "reachable",   lastSeen: "4m ago" },
  { did: "z6Mkk8miJB", url: "https://node.nipmod.com",                status: "reachable",   lastSeen: "4m ago" },
  { did: "z6MkhEVg9D", url: "https://your-node.example.com",          status: "unreachable", lastSeen: "4m ago" },
];
const TOWER_FIELD_RADIUS = 520;
const TOWER_ANGLES_DEG = [18, 50, 82, 118, 150, 198, 230, 262, 298, 332];

app.get("/api/peers", (req, res) => {
  refreshArtIndex();
  const reachablePool   = ART_INDEX.towers.filter(u => u.includes("tower-reachable")).sort();
  const unreachablePool = ART_INDEX.towers.filter(u => u.includes("tower-unreach")).sort();
  const peers = SEED_PEERS.map((p, i) => {
    const pool = p.status === "reachable" ? reachablePool : unreachablePool;
    const idx  = pool.length ? (hashStr(p.did) % pool.length) : 0;
    const towerUrl = pool[idx] || null;
    const angle = (TOWER_ANGLES_DEG[i % TOWER_ANGLES_DEG.length] * Math.PI) / 180;
    return {
      ...p,
      towerUrl,
      towerSpriteUrl: cutoutUrlFor(towerUrl, 256),
      x: Math.cos(angle) * TOWER_FIELD_RADIUS,
      z: Math.sin(angle) * TOWER_FIELD_RADIUS,
    };
  });
  res.json({
    peers,
    total: peers.length,
    reachable: peers.filter(p => p.status === "reachable").length,
    unreachable: peers.filter(p => p.status === "unreachable").length,
    source: GITLAWB_BASE + "/node/peers",
  });
});

app.get("/api/wallet/:address", (req, res) => {
  const w = getOrCreateWallet(req.params.address);
  res.json({ address: req.params.address, ...w });
});
app.get("/api/wallet/:address/buildings", (req, res) => {
  const addr = req.params.address;
  const buildings = [];
  for (const [fullId, m] of Object.entries(STATE.mints)) {
    if (m.owner === addr) {
      const repo = REPOS.find((r) => r.fullId === fullId);
      if (repo) buildings.push({ ...repo, ...m, fullId });
    }
  }
  res.json({ address: addr, buildings });
});

app.post("/api/arcade/score", (req, res) => {
  const { walletAddress, score, reward } = req.body || {};
  if (!walletAddress || typeof score !== "number") {
    return res.status(400).json({ ok: false, error: "walletAddress and score required" });
  }
  const prev = STATE.arcadeScores[walletAddress] || 0;
  if (score > prev) STATE.arcadeScores[walletAddress] = score;
  if (typeof reward === "number" && reward > 0) {
    const w = getOrCreateWallet(walletAddress);
    w.lawb += reward;
  }
  saveState();
  res.json({ ok: true, best: STATE.arcadeScores[walletAddress] });
});
app.get("/api/arcade/leaderboard", (req, res) => {
  const rows = Object.entries(STATE.arcadeScores)
    .map(([addr, score]) => ({ address: addr, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
  res.json({ rows });
});

app.post("/api/dev/grant", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ ok: false, error: "disabled_in_prod" });
  }
  const { walletAddress, lawb } = req.body || {};
  if (!walletAddress) return res.status(400).json({ ok: false, error: "walletAddress required" });
  const w = getOrCreateWallet(walletAddress);
  w.lawb += parseInt(lawb || "100", 10);
  saveState();
  res.json({ ok: true, balance: w.lawb });
});

function buildNftArtPrompt(repo) {
  return [
    "3D pixel-art voxel building, isometric camera, glowing neon windows.",
    `Rarity tier: ${repo.rarity} (color accent ${repo.rarityColor}).`,
    `Repo: ${repo.name} (${repo.fullId}). Mood: ${repo.desc.slice(0, 200)}.`,
    "Style: low-poly Minecraft-meets-cyberpunk, dark navy sky (#060912), mint teal accent (#00f5d4),",
    "gold highlights (#ffbe0b), centered single tower on a dark plinth, no text, no UI.",
    "16-bit pixel feel, crisp aliasing, dramatic rim light, square 1:1.",
  ].join(" ");
}

app.post("/api/ai/nft-art", async (req, res) => {
  try {
    const { fullId, prompt: extra } = req.body || {};
    if (!fullId) return res.status(400).json({ ok: false, error: "fullId required" });
    const repo = REPOS.find((r) => r.fullId === fullId);
    if (!repo) return res.status(404).json({ ok: false, error: "repo_not_found" });
    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({ ok: false, error: "ai_disabled", hint: "Set OPENROUTER_API_KEY in server/.env" });
    }
    const prompt = buildNftArtPrompt(repo) + (extra ? " Extra: " + String(extra).slice(0, 400) : "");
    const { imageUrl, raw } = await openrouterImage({ prompt });
    if (!imageUrl) {
      return res.status(502).json({ ok: false, error: "no_image_in_response", debug: raw?.choices?.[0]?.finish_reason || null });
    }
    const m = STATE.mints[fullId];
    if (m) {
      m.imageUrl = imageUrl;
      m.imagePrompt = prompt;
      m.imageGeneratedAt = Date.now();
      saveState();
    }
    res.json({ ok: true, fullId, prompt, imageUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/ai/city-layout", async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({ ok: false, error: "ai_disabled", hint: "Set OPENROUTER_API_KEY in server/.env" });
    }
    const theme = (req.body?.theme || "cyberpunk neon").slice(0, 200);
    const districts = Math.min(parseInt(req.body?.districts || "6", 10), 12);
    const sysPrompt =
      "You design 3D pixel-art voxel city layouts. Respond ONLY with strict JSON, no prose. " +
      "Schema: {\"districts\":[{\"name\":\"\",\"centerX\":0,\"centerZ\":0,\"radius\":0,\"palette\":[\"#hex\"],\"style\":\"\",\"motif\":\"\"}],\"skyColor\":\"#hex\",\"groundColor\":\"#hex\"}.";
    const userPrompt =
      `Generate a ${districts}-district city layout for a 3D voxel game where every building is a gitlawb repo (${REPOS.length} total). ` +
      `Theme: "${theme}". Spread districts across a 400x400 grid centered on (0,0). Keep each radius between 30 and 90. ` +
      `Pick palettes that work with the existing accents: mint #00f5d4, gold #ffbe0b, dark navy #060912.`;
    const r = await openrouterChat({
      model: OPENROUTER_TEXT_MODEL,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.8,
      response_format: { type: "json_object" },
    });
    const raw = r?.choices?.[0]?.message?.content || "{}";
    let layout;
    try { layout = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      layout = m ? JSON.parse(m[0]) : { districts: [] };
    }
    res.json({ ok: true, layout, model: OPENROUTER_TEXT_MODEL });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "endpoint_not_found", path: req.path });
});

function sendNoCache(res, file) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.sendFile(file);
}

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/", (req, res) => {
  const idx = path.join(__dirname, "..", "index.html");
  if (fs.existsSync(idx)) return sendNoCache(res, idx);
  res.send("LAWBWORLD API — frontend not deployed. POST /api/* or open index.html separately.");
});

app.get("/discover", (req, res) => sendNoCache(res, path.join(__dirname, "..", "discover.html")));
app.get("/mint",     (req, res) => sendNoCache(res, path.join(__dirname, "..", "mint.html")));
app.get("/mint/:did/:name", (req, res) => {
  res.redirect(`/mint?id=${encodeURIComponent(req.params.did + "/" + req.params.name)}`);
});

loadState();
loadReposFromDisk();
refreshArtIndex({ maxAgeMs: 0 });
{
  const c = ART_INDEX.buildings;
  const total = c.common.length + c.uncommon.length + c.rare.length + c.epic.length + c.legendary.length;
  console.log(`[art] ${total} building images (L:${c.legendary.length} E:${c.epic.length} R:${c.rare.length} U:${c.uncommon.length} C:${c.common.length}) · ${ART_INDEX.towers.length} towers`);
  if (!total) console.log(`[art] empty — run: node scripts/generate-art.js`);
}

{
  const w = getSignerWallet();
  if (w && LAWB_BUILDING_PROXY) {
    console.log(`[mint-sig] signer ${w.address} → chain ${CHAIN_ID} proxy ${LAWB_BUILDING_PROXY}`);
  } else {
    console.log(`[mint-sig] disabled — missing MINT_SIGNER_KEY or LAWB_BUILDING_PROXY in server/.env`);
  }
}

if (indexerReady()) {
  console.log(`[indexer] watching ${LAWB_BUILDING_PROXY} on chain ${CHAIN_ID} via ${CHAIN_RPC} (resume @ block ${_indexedToBlock || INDEXER_FROM_BLOCK})`);
  indexFromChain().catch(e => console.warn("[indexer] initial:", e.message));
  setInterval(() => indexFromChain().catch(e => console.warn("[indexer] poll:", e.message)), INDEXER_POLL_MS);
} else {
  console.log(`[indexer] disabled — set LAWB_BUILDING_PROXY in server/.env`);
}

async function prewarmArtCache() {
  if (!sharp) return;
  const SIZES = [128, 256];
  const all = [];
  for (const tier of Object.keys(ART_INDEX.buildings)) {
    for (const url of ART_INDEX.buildings[tier]) {
      const rel = url.replace("/assets/art/", "");
      all.push(rel);
    }
  }
  for (const url of ART_INDEX.towers) {
    all.push(url.replace("/assets/art/", ""));
  }
  let done = 0, made = 0;
  for (const rel of all) {
    const src = path.join(ART_DIR, rel);
    if (!fs.existsSync(src)) continue;
    for (const size of SIZES) {
      const thumbFile = path.join(THUMB_DIR, String(size), rel);
      if (!fs.existsSync(thumbFile)) {
        try {
          fs.mkdirSync(path.dirname(thumbFile), { recursive: true });
          await sharp(src).resize(size, size, { fit: "cover" }).png({ quality: 88 }).toFile(thumbFile);
          made++;
        } catch (_) {}
      }
    }
    const cutFile = path.join(CUTOUT_DIR, "256", rel);
    if (!fs.existsSync(cutFile)) {
      try {
        fs.mkdirSync(path.dirname(cutFile), { recursive: true });
        const { data, info } = await sharp(src).resize(256, 256, { fit: "cover" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const px = info.width * info.height;
        const LUMA_CUT = 32, LUMA_KEEP = 70;
        for (let i = 0; i < px; i++) {
          const o = i * 4;
          const luma = data[o]*0.2126 + data[o+1]*0.7152 + data[o+2]*0.0722;
          if (luma <= LUMA_CUT) data[o+3] = 0;
          else if (luma < LUMA_KEEP) data[o+3] = Math.round(((luma - LUMA_CUT) / (LUMA_KEEP - LUMA_CUT)) * 255);
        }
        await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(cutFile);
        made++;
      } catch (_) {}
    }
    done++;
  }
  if (made) console.log(`[art] pre-warmed ${made} thumb/cutout file(s) for ${done} sources`);
  else      console.log(`[art] cache warm (${done} sources)`);
}
prewarmArtCache().catch(e => console.warn("[art] prewarm failed:", e.message));

refreshRepoIndex({ force: !REPOS.length }).catch(e => console.warn("[sync] initial:", e.message));
setInterval(() => {
  refreshRepoIndex().catch(e => console.warn("[sync] periodic:", e.message));
}, REPO_REFRESH_MIN * 60 * 1000);

app.listen(PORT, HOST, () => {
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│                                                     │");
  console.log("│        LAWBWORLD API · alpha · v0.4.0               │");
  console.log("│                                                     │");
  console.log(`│  listening on  http://${HOST}:${PORT}` + " ".repeat(Math.max(0, 26 - HOST.length - String(PORT).length)) + "│");
  console.log(`│  repos:        ${REPOS.length}` + " ".repeat(Math.max(0, 36 - String(REPOS.length).length)) + "│");
  console.log(`│  ai:           ${OPENROUTER_API_KEY ? "openrouter ON " : "disabled      "}` + " ".repeat(22) + "│");
  console.log("│                                                     │");
  console.log("│  open the city → http://localhost:" + PORT + "/" + " ".repeat(Math.max(0, 13 - String(PORT).length)) + "│");
  console.log("│                                                     │");
  console.log("└─────────────────────────────────────────────────────┘");
});

process.on("SIGINT",  () => { saveState(); setTimeout(() => process.exit(0), 300); });
process.on("SIGTERM", () => { saveState(); setTimeout(() => process.exit(0), 300); });
