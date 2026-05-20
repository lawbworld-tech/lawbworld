#!/usr/bin/env node
/**
 * Lawbworld — pre-generate the art library
 *
 *   node scripts/generate-art.js          (skip existing files)
 *   node scripts/generate-art.js --force  (regenerate everything)
 *
 * Generates a small fixed pool of 3D pixel-art voxel images via OpenRouter and
 * saves them as PNGs under server/data/art/. The server later assigns one to
 * every repo deterministically (seeded hash → image index) so the city /
 * Discover / NFT-mint UI can <img src> them with zero runtime API calls.
 *
 *   data/art/buildings/<tier>/<n>.png    (tier = common|uncommon|rare|epic|legendary)
 *   data/art/towers/<n>.png
 *
 * Default model: google/gemini-2.5-flash-image-preview (the "nano-banana"
 * native image model). Override with OPENROUTER_IMAGE_MODEL.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE    = "https://openrouter.ai/api/v1";
const MODEL              = process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-2.5-flash-image-preview";
const SITE_URL           = process.env.OPENROUTER_SITE_URL || "https://lawbworld.local";
const APP_NAME           = process.env.OPENROUTER_APP_NAME || "Lawbworld";

const ART_ROOT     = path.join(__dirname, "..", "data", "art");
const BUILD_ROOT   = path.join(ART_ROOT, "buildings");
const TOWER_ROOT   = path.join(ART_ROOT, "towers");

if (!OPENROUTER_API_KEY) {
  console.error("✗ OPENROUTER_API_KEY missing — set it in server/.env first");
  process.exit(1);
}

const FORCE = process.argv.includes("--force");

const TIERS = [
  { name: "legendary", count: 15, accent: "#fbbf24", motif: "elegant minimalist luxury tower, slim tall silhouette with restrained art-deco vertical gold pinstripes running floor-to-floor, polished black-marble panels with subtle gold filigree at the cornice of each setback, floor-to-ceiling glass penthouse windows with warm interior glow, a single elegant glowing gold crown emblem at the very top instead of a busy ring, one slim vertical antenna, a single discreet rooftop palm in a black marble planter, small clean balcony ledge on the penthouse floor with one chaise, mirror-glass spire crowning the top, gentle gold uplighting along the base, refined symmetric composition, NO heavy ornament NO crowded details NO awning NO street props beyond a small dark marble plinth and one tasteful lamppost, window grid roughly 60 percent lit with a mix of warm gold and mint cyan and a few flickering pink-magenta panels with RGB chromatic shift and subtle scanline glitch" },
  { name: "epic",      count: 15, accent: "#c084fc", motif: "tall cyberpunk apartment tower with two terraced setbacks, magenta and violet neon edge ribs running up every floor, dense grid of small square windows about 60 percent lit (a mix of hot magenta + violet + a few cyan flicker panels with RGB chromatic shift and signal noise), tiny voxel balconies with neon planters and rooftop antennae, hot tub glow visible on a setback, vending-machine glow at the lobby, glowing entrance awning on the sidewalk plinth" },
  { name: "rare",      count: 15, accent: "#38bdf8", motif: "polished glass mid-rise apartment tower with ice-blue lit window grid (~50 percent lit, with subtle scanline interference and one column of flicker-glitch panels), sharp cyan rim trim along every horizontal edge, flat roof with HVAC vents and a small antenna, clean voxel rectangular balconies with a few plants, bicycles parked at the base, glowing doorway on the sidewalk plinth" },
  { name: "uncommon",  count: 15, accent: "#34d399", motif: "cozy mid-size apartment block wrapped in lush green ivy and wooden balcony rails with hanging planters, mint-green neon strip glowing along the lobby (NO letters, just a glowing bar), square window grid about 40 percent lit (mint + warm yellow, a few flickering panels and one with static interference), rooftop garden with potted plants and string lights, antenna spike, lamppost on the sidewalk plinth" },
  { name: "common",    count: 15, accent: "#5b6478", motif: "modest low-rise apartment block with painted brick facade, small balconies with potted plants and a folding chair on a couple of floors, corrugated metal roof with a single TV antenna, square window grid about 30 percent lit (cyan + warm yellow, several flickering panels and a few visibly dead black windows), faint cyan signage strip glowing along the lobby (a pure glowing bar, NO letters), trash bin on the sidewalk plinth" },
];

const TOWERS = [
  { name: "tower-reachable", count: 8, accent: "#00f5d4", motif: "extremely tall slim transmitter tower with steel lattice scaffold, large parabolic mint-neon satellite dish near the top, multiple horizontal signal arms with blinking lights, antenna spike at the top, concrete plinth, tall vertical 9:16 composition" },
  { name: "tower-unreach",   count: 2, accent: "#ff3b3b", motif: "extremely tall slim transmitter tower with rusted patina, broken red warning beacon at the top spitting sparks, dim antenna arms, fractured satellite dish dangling, cracked concrete plinth, tall vertical 9:16 composition" },
];

const COMMON_STYLE = [
  "2D pixel-art voxel building NFT in the Spellborne Apartments / Cool Cats Habitats aesthetic, isometric front-three-quarter perspective of a single building filling the frame.",
  "Crisp pixel-art edges with NO anti-aliasing, every voxel block clearly defined, hand-drawn outlines, parallax depth between floors, subtle interior glow from lit windows.",
  "Lawbworld palette: dark navy #060912 night sky background with a few small stars, mint #00f5d4, gold #ffbe0b, hot magenta #ff006e, the rarity tier color as the dominant facade hue.",
  "Windows are a clean square grid of small lit and dark panels with deliberate broken-screen GLITCH effects on several panels — RGB chromatic shift, scanline interference, signal static, missing pixels, occasional flickering off — like malfunctioning cyberpunk monitors mixed with cozy lit rooms.",
  "ABSOLUTELY NO TEXT of any kind: NO LETTERS, NO WORDS, NO NUMBERS, NO ENGLISH, NO READABLE SIGNAGE, NO LOGOS, NO BRAND NAMES, NO WATERMARKS, NO UI OVERLAYS, NO LABELS, NO MARQUEE TEXT. Signs are pure glowing bars/shapes only.",
  "Building centered on a small dark plinth or street-level slice (sidewalk + lamppost + a few details), deep navy gradient backdrop. Subject fills 70 percent of frame, square 1:1 composition, ambient occlusion at corners.",
].join(" ");

function buildPrompt(motif, accentHex, seedIdx){
  return `${COMMON_STYLE} Primary subject: ${motif}. Dominant accent color: ${accentHex}. Composition variation seed: ${seedIdx}.`;
}

async function openrouterImage(prompt){
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": SITE_URL,
      "X-Title": APP_NAME,
    },
    body: JSON.stringify({
      model: MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;

  const candidates = [];
  if (Array.isArray(msg?.images)) candidates.push(...msg.images);
  if (Array.isArray(msg?.content)) candidates.push(...msg.content);
  for (const c of candidates) {
    const url = c?.image_url?.url || c?.image?.url || c?.url;
    if (typeof url === "string") return url;
  }
  if (Array.isArray(data?.images) && data.images[0]) {
    return data.images[0]?.url || data.images[0];
  }
  throw new Error("no image in response — check model supports image generation");
}

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function writeImageFile(dataUrl, outFile){
  const m = String(dataUrl).match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) {
    fs.writeFileSync(outFile.replace(/\.png$/, ".url"), dataUrl);
    return { kind: "url" };
  }
  fs.writeFileSync(outFile, Buffer.from(m[2], "base64"));
  return { kind: "png", bytes: Buffer.byteLength(m[2], "base64") * 0.75 };
}

async function generateOne(outFile, prompt){
  if (!FORCE && fs.existsSync(outFile)) {
    console.log(`  skip (exists): ${path.relative(ART_ROOT, outFile)}`);
    return;
  }
  const t0 = Date.now();
  try {
    const url = await openrouterImage(prompt);
    const res = writeImageFile(url, outFile);
    const ms = Date.now() - t0;
    console.log(`  ✓ ${path.relative(ART_ROOT, outFile)} (${res.kind}${res.bytes ? `, ${Math.round(res.bytes/1024)} KB` : ""}, ${ms} ms)`);
  } catch (e) {
    console.error(`  ✗ ${path.relative(ART_ROOT, outFile)} — ${e.message}`);
  }
}

async function main(){
  ensureDir(BUILD_ROOT);
  ensureDir(TOWER_ROOT);
  console.log(`\nlawbworld art-gen · model=${MODEL} · force=${FORCE}\n`);

  for (const t of TIERS) {
    ensureDir(path.join(BUILD_ROOT, t.name));
    console.log(`▌ ${t.name.toUpperCase()} (${t.count})`);
    for (let i = 0; i < t.count; i++) {
      const out = path.join(BUILD_ROOT, t.name, `${i}.png`);
      const prompt = buildPrompt(t.motif, t.accent, i);
      await generateOne(out, prompt);
    }
  }

  console.log(`\n▌ TOWERS (${TOWERS.reduce((a,t)=>a+t.count,0)})`);
  for (const t of TOWERS) {
    for (let i = 0; i < t.count; i++) {
      const out = path.join(TOWER_ROOT, `${t.name}-${i}.png`);
      const prompt = buildPrompt(t.motif, t.accent, i);
      await generateOne(out, prompt);
    }
  }

  console.log("\n✓ done. The server now serves these at /assets/art/*\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
