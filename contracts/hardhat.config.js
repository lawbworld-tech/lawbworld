require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

const PRIVATE_KEY        = process.env.PRIVATE_KEY        || "0x0000000000000000000000000000000000000000000000000000000000000001";
const BASE_RPC_URL       = process.env.BASE_RPC_URL       || "https://base.publicnode.com";
const BASE_SEPOLIA_RPC   = process.env.BASE_SEPOLIA_RPC   || "https://base-sepolia.publicnode.com";
const ETHERSCAN_API_KEY  = process.env.ETHERSCAN_API_KEY  || process.env.BASESCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: false,
    },
  },
  networks: {
    hardhat: {},
    "base-sepolia": {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: [PRIVATE_KEY],
    },
    base: {
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts: [PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  sourcify: { enabled: false },
};
