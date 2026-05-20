const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const mintSigner      = process.env.MINT_SIGNER      || deployer.address;
  const royaltyReceiver = process.env.ROYALTY_RECEIVER || deployer.address;
  const royaltyBps      = parseInt(process.env.ROYALTY_BPS || "500", 10);

  console.log("\n→ deploying LawbBuilding (UUPS proxy)...");
  console.log("  initialOwner    =", deployer.address);
  console.log("  mintSigner      =", mintSigner);
  console.log("  royaltyReceiver =", royaltyReceiver);
  console.log("  royaltyBps      =", royaltyBps, "(=", (royaltyBps / 100).toFixed(2), "%)");

  const Building = await hre.ethers.getContractFactory("LawbBuilding");
  const proxy = await hre.upgrades.deployProxy(
    Building,
    [deployer.address, mintSigner, royaltyReceiver, royaltyBps],
    { kind: "uups", initializer: "initialize" }
  );
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  const implAddr  = await hre.upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log("  proxy:          ", proxyAddr);
  console.log("  implementation: ", implAddr);

  const network = hre.network.name;
  console.log("\n────────────────────────────────");
  console.log("Deployment complete on:", network);
  console.log("LAWB_BUILDING_PROXY  =", proxyAddr);
  console.log("LAWB_BUILDING_IMPL   =", implAddr);
  console.log("MINT_SIGNER          =", mintSigner);
  console.log("ROYALTY_RECEIVER     =", royaltyReceiver);
  console.log("────────────────────────────────");

  if (network === "hardhat" || network === "localhost") {
    console.log("\nSkipping verify on local network.");
    return;
  }

  console.log("\n→ waiting 10s for BaseScan to index implementation...");
  await new Promise(r => setTimeout(r, 10000));

  console.log("\n→ verifying implementation on BaseScan...");
  try {
    await hre.run("verify:verify", { address: implAddr, constructorArguments: [] });
    console.log("  ✓ implementation verified");
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already verified")) {
      console.log("  ✓ implementation already verified");
    } else {
      console.warn("  ✗ implementation verify failed:", e.message);
      console.warn("    retry manually: npx hardhat verify --network " + network + " " + implAddr);
    }
  }

  console.log("\n→ verifying proxy on BaseScan (ERC-1967)...");
  try {
    await hre.run("verify:verify", { address: proxyAddr, constructorArguments: [] });
    console.log("  ✓ proxy verified");
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already verified")) {
      console.log("  ✓ proxy already verified");
    } else {
      console.warn("  ✗ proxy verify failed:", e.message);
      console.warn("    retry manually: npx hardhat verify --network " + network + " " + proxyAddr);
    }
  }

  const explorer = network === "base" ? "https://basescan.org"
                : network === "base-sepolia" ? "https://sepolia.basescan.org"
                : "";
  if (explorer) {
    console.log("\n→ live links:");
    console.log("  proxy:          " + explorer + "/address/" + proxyAddr);
    console.log("  implementation: " + explorer + "/address/" + implAddr);
  }

  console.log("\nNext steps:");
  console.log("  1. Deploy $LAWBWORLD on Bankr launchpad.");
  console.log("  2. As owner, call setLawbworldToken(<address>) on the proxy.");
  console.log("  3. Ensure server signing key matches MINT_SIGNER above.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
