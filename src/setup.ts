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
  const infraAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "solinfraKey",
      message: "Enter SolInfra API Key (Required for high-perf RPC/gRPC):",
      default: envConfig["SOLINFRA_API_KEY"] || "",
      validate: (input) => input.length > 0 || "SolInfra Key is mandatory.",
    },
    {
      type: "list",
      name: "network",
      message: "Target Solana Network:",
      choices: ["testnet", "mainnet-beta", "devnet"],
      default: envConfig["NETWORK"] || "testnet",
    }
  ]);

  envConfig["SOLINFRA_API_KEY"] = infraAnswers.solinfraKey;
  envConfig["NETWORK"] = infraAnswers.network;
  envConfig["RPC_URL"] = `https://fra.rpc.solinfra.dev/sol?api_key=${infraAnswers.solinfraKey}`;
  envConfig["GRPC_URL"] = "fra.grpc.solinfra.dev:443";
  envConfig["BLOCK_ENGINE_URL"] = infraAnswers.network === "testnet" ? "ny.testnet.block-engine.jito.wtf" : "ny.mainnet.block-engine.jito.wtf";

  // --- 2. AI CONFIGURATION ---
  console.log(chalk.yellow.bold("\n[2/3] AI Agent Configuration"));
  const aiChoices = [
    { name: "Gemini (Google) - High Speed / Balanced", value: "gemini" },
    { name: "Claude (Anthropic) - Precision / Best for failure analysis", value: "anthropic" },
    { name: "OpenAI (GPT-4o) - Industry Standard", value: "openai" },
    { name: "DeepSeek - Performance / Cost Efficiency", value: "deepseek" },
    { name: "Grok (xAI) - Advanced Context", value: "grok" },
    { name: "LM Studio (Local LLM) - Maximum Privacy / Zero Cost", value: "lmstudio" },
  ];

  const aiType = await inquirer.prompt([
    {
      type: "list",
      name: "provider",
      message: "Select your Primary AI Provider:",
      choices: aiChoices,
      default: envConfig["AI_PROVIDER"] || "gemini",
    }
  ]);

  envConfig["AI_PROVIDER"] = aiType.provider;

  if (aiType.provider === "lmstudio") {
    console.log(chalk.blue.bold("\n--- LM STUDIO INSTALLATION GUIDE ---"));
    console.log("1. Download LM Studio from: " + chalk.underline("https://lmstudio.ai/"));
    console.log("2. Open the app and download a model (e.g., Llama 3.2 3B).");
    console.log("3. Click the '<->' icon on the left to open 'Local Server'.");
    console.log("4. Click 'Start Server' on port 1234.");
    console.log("------------------------------------\n");
    
    const localModel = await inquirer.prompt([
      {
        type: "input",
        name: "id",
        message: "Enter your loaded model identifier (or leave as 'any'):",
        default: "any",
      }
    ]);
    envConfig["LOCAL_MODEL_ID"] = localModel.id;
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
  console.log(`\nNext: Fund your wallets and run: ${chalk.bold("npm start")}`);
}

main().catch((err) => {
  console.error(chalk.red("\n[Error]"), err.message);
  process.exit(1);
});
