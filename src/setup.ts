import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.clear();
  console.log(chalk.cyan.bold("=================================================="));
  console.log(chalk.cyan.bold("   PRISMA AI - TRANSACTION STACK SETUP   "));
  console.log(chalk.cyan.bold("==================================================\n"));

  const envPath = path.join(process.cwd(), ".env");
  let envConfig: Record<string, string> = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    content.split("\n").forEach((line) => {
      const parts = line.split("=");
      if (parts.length >= 2) envConfig[parts[0].trim()] = parts.slice(1).join("=").trim();
    });
  }

  // --- 1. INFRASTRUCTURE ---
  console.log(chalk.yellow.bold("[1/3] Infrastructure Configuration"));
  
  const setupMode = await inquirer.prompt([
    {
      type: "select",
      name: "mode",
      message: "Infrastructure Mode:",
      choices: [
        { name: "Default (SolInfra RPC + gRPC Geyser)", value: "solinfra" },
        { name: "Custom (Your own Yellowstone gRPC & custom RPC)", value: "custom" }
      ],
      default: envConfig["INFRA_MODE"] || "solinfra"
    }
  ]);

  envConfig["INFRA_MODE"] = setupMode.mode;

  let rpcUrl = "";
  let grpcUrl = "";
  let solinfraKey = "";
  let blockEngineUrl = "";

  const commonAnswers = await inquirer.prompt([
    {
      type: "select",
      name: "network",
      message: "Target Solana Network:",
      choices: ["testnet", "mainnet-beta", "devnet"],
      default: envConfig["NETWORK"] || "testnet",
    }
  ]);

  const network = commonAnswers.network;
  envConfig["NETWORK"] = network;

  if (setupMode.mode === "solinfra") {
    const infraAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "solinfraKey",
        message: "Enter SolInfra API Key:",
        default: envConfig["SOLINFRA_API_KEY"] || "",
        validate: (input) => input.length > 0 || "SolInfra Key is mandatory for SolInfra mode.",
      }
    ]);
    solinfraKey = infraAnswers.solinfraKey;
    rpcUrl = `https://fra.rpc.solinfra.dev/sol?api_key=${solinfraKey}`;
    grpcUrl = "fra.grpc.solinfra.dev:443";
    blockEngineUrl = network === "testnet" ? "ny.testnet.block-engine.jito.wtf" : (network === "devnet" ? "dallas.devnet.block-engine.jito.wtf" : "ny.mainnet.block-engine.jito.wtf");
  } else {
    const customAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "rpcUrl",
        message: "Enter Custom Solana RPC URL:",
        default: envConfig["RPC_URL"] || (network === "testnet" ? "https://api.testnet.solana.com" : (network === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com")),
        validate: (input) => input.length > 0 || "RPC URL is mandatory.",
      },
      {
        type: "input",
        name: "grpcUrl",
        message: "Enter Custom Yellowstone gRPC Endpoint (host:port):",
        default: envConfig["GRPC_URL"] || "",
        validate: (input) => input.length > 0 || "Yellowstone gRPC endpoint is mandatory.",
      },
      {
        type: "input",
        name: "solinfraKey",
        message: "Enter Auth Token/Key for Custom gRPC (Press Enter if none):",
        default: envConfig["SOLINFRA_API_KEY"] || "",
      },
      {
        type: "input",
        name: "blockEngineUrl",
        message: "Enter Jito Block Engine URL (host or domain):",
        default: envConfig["BLOCK_ENGINE_URL"] || (network === "testnet" ? "ny.testnet.block-engine.jito.wtf" : (network === "devnet" ? "dallas.devnet.block-engine.jito.wtf" : "ny.mainnet.block-engine.jito.wtf")),
        validate: (input) => input.length > 0 || "Block Engine URL is mandatory.",
      }
    ]);
    solinfraKey = customAnswers.solinfraKey;
    rpcUrl = customAnswers.rpcUrl;
    grpcUrl = customAnswers.grpcUrl;
    blockEngineUrl = customAnswers.blockEngineUrl;
  }

  envConfig["SOLINFRA_API_KEY"] = solinfraKey;
  envConfig["RPC_URL"] = rpcUrl;
  envConfig["GRPC_URL"] = grpcUrl;
  envConfig["BLOCK_ENGINE_URL"] = blockEngineUrl;

  // --- 2. AI CONFIGURATION ---
  console.log(chalk.yellow.bold("\n[2/3] AI Agent Configuration"));
  const aiChoices = [
    { name: "Gemini (Google) - High Speed / Balanced", value: "gemini" },
    { name: "Claude (Anthropic) - Precision / Best for failure analysis", value: "anthropic" },
    { name: "OpenAI (GPT-4o) - Industry Standard", value: "openai" },
    { name: "DeepSeek - Performance / Cost Efficiency", value: "deepseek" },
    { name: "LM Studio (Local LLM) - Maximum Privacy / Zero Cost", value: "lmstudio" },
    { name: "Ollama (Local LLM) - Highly customizable / Offline", value: "ollama" },
  ];

  const aiType = await inquirer.prompt([
    {
      type: "select",
      name: "provider",
      message: "Select your Primary AI Provider:",
      choices: aiChoices,
      default: envConfig["AI_PROVIDER"] || "gemini",
    }
  ]);

  envConfig["AI_PROVIDER"] = aiType.provider;

  if (aiType.provider === "lmstudio" || aiType.provider === "ollama") {
    const defaultUrl = aiType.provider === "lmstudio" ? "http://localhost:1234/v1" : "http://localhost:11434";
    const defaultModel = aiType.provider === "lmstudio" ? "any" : "llama3";
    
    const localAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "url",
        message: `Enter local model base URL for ${aiType.provider.toUpperCase()}:`,
        default: envConfig["AI_URL"] || defaultUrl,
      },
      {
        type: "input",
        name: "modelName",
        message: "Enter model identifier/name:",
        default: envConfig["AI_MODEL"] || defaultModel,
      }
    ]);
    envConfig["AI_URL"] = localAnswers.url;
    envConfig["AI_MODEL"] = localAnswers.modelName;
  } else {
    const keyName = `${aiType.provider.toUpperCase()}_API_KEY`;
    const aiKey = await inquirer.prompt([
      {
        type: "input",
        name: "key",
        message: `Enter your ${aiType.provider.toUpperCase()} API Key:`,
        default: envConfig[keyName] || "",
        validate: (input) => input.length > 0 || "API Key is required for cloud providers.",
      }
    ]);
    envConfig[keyName] = aiKey.key;
  }

  // --- 3. FINALIZATION ---
  envConfig["SETUP_COMPLETE"] = "true";
  const envContent = Object.entries(envConfig).map(([k, v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(envPath, envContent);

  console.log(chalk.green.bold("\n=================================================="));
  console.log(chalk.green.bold("   CONFIGURATION COMPLETE!   "));
  console.log(chalk.green.bold("=================================================="));
  console.log(`\nNetwork:      ${chalk.cyan(envConfig["NETWORK"])}`);
  console.log(`AI Provider:  ${chalk.cyan(envConfig["AI_PROVIDER"].toUpperCase())}`);
  console.log(`RPC Endpoint: ${chalk.cyan(envConfig["RPC_URL"])}`);
  console.log(`gRPC Geyser:  ${chalk.cyan(envConfig["GRPC_URL"])}`);
  console.log(`\nNext: Fund your wallets and run: ${chalk.bold("npm start")}`);
}

main().catch((err) => {
  console.error(chalk.red("\n[Error]"), err.message);
  process.exit(1);
});
