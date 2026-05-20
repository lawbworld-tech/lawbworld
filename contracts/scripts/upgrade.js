const hre = require("hardhat");

async function main() {
  const proxyAddr = process.env.LAWB_BUILDING_PROXY || process.argv[2];
  if (!proxyAddr) {
    console.error("Set LAWB_BUILDING_PROXY env or pass as arg");
    process.exit(1);
  }
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Upgrading proxy:", proxyAddr);

  const Building = await hre.ethers.getContractFactory("LawbBuilding");
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddr, Building, { kind: "uups" });
  await upgraded.waitForDeployment();
  const implAddr = await hre.upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log("  new implementation:", implAddr);

  const network = hre.network.name;
  if (network !== "hardhat" && network !== "localhost") {
    console.log("\n→ waiting 10s, then verifying impl on Etherscan...");
    await new Promise(r => setTimeout(r, 10000));
    try {
      await hre.run("verify:verify", { address: implAddr, constructorArguments: [] });
      console.log("  ✓ verified");
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      if (msg.includes("already verified")) console.log("  ✓ already verified");
      else console.warn("  ✗ verify failed:", e.message);
    }
  }
  console.log("\n✓ done.");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
