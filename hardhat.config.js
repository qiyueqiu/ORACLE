require("@nomicfoundation/hardhat-toolbox");
// override:true —— 以根 .env 文件为单一来源，覆盖 shell 中可能残留的旧 export
// （如本地开发时 export 的 PROVIDER_URL=localhost / CHAIN_ID=31337）。
require("dotenv").config({ override: true });

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

// 私钥规范化：补 0x 前缀（hardhat accounts 要求带前缀）
const _normPk = (k) => (k ? (k.startsWith("0x") ? k : "0x" + k) : null);
// Sepolia 账户：优先 SEPOLIA_DEPLOYER_PRIVATE_KEY，回退到项目已有的 ROUTER_SIGNER_KEY
// （单账户模式：同一个充值钱包扮演 deployer/router/worker/requester，见 benchmark.js 的 fallback）
const SEPOLIA_PK = _normPk(SEPOLIA_DEPLOYER_PRIVATE_KEY || process.env.ROUTER_SIGNER_KEY);
const SEPOLIA_ACCOUNTS = SEPOLIA_PK ? [SEPOLIA_PK] : [];

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  // TypeChain：从 artifacts 生成 ethers-v6 类型化合约接口（typechain-types/）。
  // @typechain/hardhat 已由 hardhat-toolbox 自动注册；后端(ESM)与前端共用生成的 Xxx__factory。
  // 本文件保持 CommonJS——根 package.json 不设 "type":"module"，以兼容 Hardhat 2.x 运行时。
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    node16Modules: true,
    // hardhat-toolbox 在 .js/.cjs 配置下默认禁用 TypeChain 的 compile 钩子
    // （toolbox/index.js: dontOverrideCompile = configFile.endsWith(".js")）。
    // 本仓库根目录刻意保持 CJS，故显式设 false 强制 compile 时生成类型。
    dontOverrideCompile: false,
  },
  // gas-reporter：用于论文 5.3 节性能数据复现（A1）
  // 默认关闭，避免拖慢日常开发；通过 REPORT_GAS=true 打开。
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: "paper/gas-report.txt",
    noColors: true,
    excludeContracts: ["MockERC20"],
  },
  networks: {
    // 本地
    localhost: { url: "http://localhost:8545", chainId: 31337 },
    hardhat: { chainId: 31337 },

    // 公共测试网（M2 N8：多网络部署支持）
    // url 优先用 SEPOLIA_RPC_URL，回退到项目已填的 PROVIDER_URL（单一来源），再回退公共 RPC
    sepolia: {
      url: SEPOLIA_RPC_URL || process.env.PROVIDER_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: SEPOLIA_ACCOUNTS,
      timeout: 60000, // 60s：容忍 Sepolia 出块 + Alchemy 偶发慢响应
    },
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
