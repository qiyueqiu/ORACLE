require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  DEPLOYER_PRIVATE_KEY,
  SEPOLIA_RPC_URL,
  SEPOLIA_DEPLOYER_PRIVATE_KEY,
  BASE_SEPOLIA_RPC_URL,
  BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY,
  POLYGON_AMOY_RPC_URL,
  POLYGON_AMOY_DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  BASESCAN_API_KEY,
  POLYGONSCAN_API_KEY,
} = process.env;

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // 本地
    localhost: { url: "http://localhost:8545", chainId: 31337 },
    hardhat: { chainId: 31337 },

    // 公共测试网（M2 N8：多网络部署支持）
    sepolia: SEPOLIA_RPC_URL ? {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: SEPOLIA_DEPLOYER_PRIVATE_KEY ? [SEPOLIA_DEPLOYER_PRIVATE_KEY] : [],
    } : { url: "https://rpc.sepolia.org", chainId: 11155111 },
    baseSepolia: BASE_SEPOLIA_RPC_URL ? {
      url: BASE_SEPOLIA_RPC_URL,
      chainId: 84532,
      accounts: BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY ? [BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY] : [],
    } : { url: "https://sepolia.base.org", chainId: 84532 },
    polygonAmoy: POLYGON_AMOY_RPC_URL ? {
      url: POLYGON_AMOY_RPC_URL,
      chainId: 80002,
      accounts: POLYGON_AMOY_DEPLOYER_PRIVATE_KEY ? [POLYGON_AMOY_DEPLOYER_PRIVATE_KEY] : [],
    } : { url: "https://rpc-amoy.polygon.technology", chainId: 80002 },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY || "",
      baseSepolia: BASESCAN_API_KEY || "",
      polygonAmoy: POLYGONSCAN_API_KEY || "",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
