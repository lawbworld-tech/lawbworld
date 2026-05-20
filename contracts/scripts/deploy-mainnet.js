/* eslint-disable no-console */
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");
const readline = require("readline");

const BASE_CHAIN_ID = 8453n;
const MIN_BALANCE_ETH = 0.005;

function fail(msg) {
  console.error("\n✗ " + msg);
  process.exit(1);
}

function isHexKey(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function isAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

async function confirm(question) {
  if (process.env.YES === "1" || process.env.CONFIRM === "1") {
    console.log(question + " [auto-yes via YES=1]");
    return true;
  }
  if (!process.stdin.isTTY) {
    fail("Non-interactive shell. Re-run with YES=1 to skip confirmation.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(question + " ", a => { rl.close(); res(a); }));
  return /^(y|yes)$/i.test(answer.trim());
}

async function main() {
  const network = hre.network.name;

  // ── 1. enforce mainnet ────────────────────────────────────────────────
  if (network !== "base") {
    fail(`This script only runs on the 'base' network (got '${network}'). Use scripts/deploy.js for other networks.`);
  }

  const provider = hre.ethers.provider;
  const net = await provider.getNetwork();
  if (net.chainId !== BASE_CHAIN_ID) {
    fail(`RPC reports chainId=${net.chainId}, expected ${BASE_CHAIN_ID} (Base mainnet). Check BASE_RPC_URL.`);
  }

  // ── 2. validate env ───────────────────────────────────────────────────
  const PK = process.env.PRIVATE_KEY;
  if (!isHexKey(PK)) {
    fail("PRIVATE_KEY missing or malformed (need 0x + 64 hex chars). Set it in contracts/.env.");
  }
  if (PK === "0x" + "0".repeat(63) + "1") {
    fail("PRIVATE_KEY is still the placeholder. Set the real deployer key in contracts/.env.");
  }
  if (!process.env.ETHERSCAN_API_KEY && !process.env.BASESCAN_API_KEY) {
    console.warn("⚠ ETHERSCAN_API_KEY not set — deploy will succeed but verify will fail.");
  }

  const [deployer] = await hre.ethers.getSigners();
  const mintSigner      = process.env.MINT_SIGNER      || deployer.address;
  const royaltyReceiver = process.env.ROYALTY_RECEIVER || deployer.address;
  const royaltyBps      = parseInt(process.env.ROYALTY_BPS || "500", 10);

  if (!isAddress(mintSigner))      fail("MINT_SIGNER is not a valid address.");
  if (!isAddress(royaltyReceiver)) fail("ROYALTY_RECEIVER is not a valid address.");
  if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 1000) {
    fail("ROYALTY_BPS must be an integer in [0, 1000] (max 10%).");
  }

  // ── 3. balance check ──────────────────────────────────────────────────
  const balWei = await provider.getBalance(deployer.address);
  const balEth = Number(hre.ethers.formatEther(balWei));
  if (balEth < MIN_BALANCE_ETH) {
    fail(`Deployer balance ${balEth.toFixed(6)} ETH < required ${MIN_BALANCE_ETH} ETH. Fund ${deployer.address} on Base.`);
  }

  const feeData = await provider.getFeeData();
  const gasGwei = feeData.gasPrice ? Number(hre.ethers.formatUnits(feeData.gasPrice, "gwei")) : null;

  // ── 4. summary + confirmation ─────────────────────────────────────────
  console.log("\n════════════════ LAWBWORLD · BASE MAINNET DEPLOY ════════════════");
  console.log("  network          base (chainId 8453)");
  console.log("  deployer         " + deployer.address);
  console.log("  balance          " + balEth.toFixed(6) + " ETH");
  if (gasGwei !== null) console.log("  gas price        " + gasGwei.toFixed(4) + " gwei");
  console.log("  ----- init args -----");
  console.log("  initialOwner     " + deployer.address);
  console.log("  mintSigner       " + mintSigner + (mintSigner === deployer.address ? "  (= deployer)" : ""));
  console.log("  royaltyReceiver  " + royaltyReceiver + (royaltyReceiver === deployer.address ? "  (= deployer)" : ""));
  console.log("  royaltyBps       " + royaltyBps + "  (" + (royaltyBps / 100).toFixed(2) + "%)");
  console.log("═════════════════════════════════════════════════════════════════");

  const ok = await confirm("Proceed with MAINNET deploy? (yes/no):");
  if (!ok) fail("Aborted by user.");

  // ── 5. deploy UUPS proxy ──────────────────────────────────────────────
  console.log("\n→ deploying LawbBuilding (UUPS proxy)…");
  const Building = await hre.ethers.getContractFactory("LawbBuilding");
  const proxy = await hre.upgrades.deployProxy(
    Building,
    [deployer.address, mintSigner, royaltyReceiver, royaltyBps],
    { kind: "uups", initializer: "initialize" }
  );
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  const implAddr  = await hre.upgrades.erc1967.getImplementationAddress(proxyAddr);
  const deployTx  = proxy.deploymentTransaction();
  const receipt   = deployTx ? await deployTx.wait() : null;

  console.log("  proxy           " + proxyAddr);
  console.log("  implementation  " + implAddr);
  if (receipt) console.log("  tx              " + receipt.hash + "  (block " + receipt.blockNumber + ")");

  // ── 6. write deployment artifact ──────────────────────────────────────
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = {
    network: "base",
    chainId: 8453,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      LawbBuilding: {
        proxy: proxyAddr,
        implementation: implAddr,
        initArgs: { initialOwner: deployer.address, mintSigner, royaltyReceiver, royaltyBps },
      },
    },
    tx: receipt ? { hash: receipt.hash, block: receipt.blockNumber } : null,
  };
  const outFile = path.join(outDir, "base-mainnet.json");
  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2) + "\n");
  console.log("\n→ wrote " + path.relative(process.cwd(), outFile));

  // ── 7. verify on BaseScan ─────────────────────────────────────────────
  if (!process.env.ETHERSCAN_API_KEY && !process.env.BASESCAN_API_KEY) {
    console.log("\nSkipping verify (no ETHERSCAN_API_KEY).");
  } else {
    console.log("\n→ waiting 15s for BaseScan to index…");
    await new Promise(r => setTimeout(r, 15000));

    for (const [label, addr] of [["implementation", implAddr], ["proxy", proxyAddr]]) {
      console.log("→ verifying " + label + " (" + addr + ")…");
      try {
        await hre.run("verify:verify", { address: addr, constructorArguments: [] });
        console.log("  ✓ " + label + " verified");
      } catch (e) {
        const msg = (e.message || "").toLowerCase();
        if (msg.includes("already verified")) {
          console.log("  ✓ " + label + " already verified");
        } else {
          console.warn("  ✗ " + label + " verify failed: " + e.message);
          console.warn("    retry:  npx hardhat verify --network base " + addr);
        }
      }
    }
  }

  // ── 8. next steps ─────────────────────────────────────────────────────
  console.log("\n════════════════════════ NEXT STEPS ════════════════════════");
  console.log("  1. Save these in your secrets store:");
  console.log("       LAWB_BUILDING_PROXY = " + proxyAddr);
  console.log("       LAWB_BUILDING_IMPL  = " + implAddr);
  console.log("  2. Deploy $LAWBWORLD on the Bankr launchpad.");
  console.log("  3. As owner, call setLawbworldToken(<token>) on the proxy.");
  console.log("  4. Confirm server signing key matches MINT_SIGNER above.");
  console.log("  5. View on BaseScan:");
  console.log("       https://basescan.org/address/" + proxyAddr);
  console.log("       https://basescan.org/address/" + implAddr);
  console.log("════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
