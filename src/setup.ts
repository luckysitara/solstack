import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

async function main() {
  console.clear();
  console.log(chalk.cyan.bold("=================================================="));
  console.log(chalk.cyan.bold("   SMART TRANSACTION STACK - INTERACTIVE SETUP   "));
  console.log(chalk.cyan.bold("==================================================\n"));

  const envPath = path.join(process.cwd(), ".env");
  let envConfig: Record<string, string> = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    content.split("\n").forEach((line) => {
      const parts = line.split("=");
      if (parts.length >= 2) {
        envConfig[parts[0].trim()] = parts.slice(1).join("=").trim();
      }
    });
  }

  // Check for automated testing mode
  if (process.env.NON_INTERACTIVE === "true") {
      console.log(chalk.blue("[CI] Running in non-interactive mode. Using environment defaults..."));
      envConfig["AI_PROVIDER"] = process.env.TEST_AI_PROVIDER || "gemini";
      envConfig["GEMINI_API_KEY"] = process.env.TEST_GEMINI_KEY || "";
      envConfig["SOLINFRA_API_KEY"] = "";
      envConfig["NETWORK"] = "testnet";
      envConfig["BLOCK_ENGINE_URL"] = "ny.testnet.block-engine.jito.wtf";
      envConfig["RPC_URL"] = "https://api.testnet.solana.com";
      envConfig["GRPC_URL"] = "fra.grpc.solinfra.dev:443";
      envConfig["SETUP_COMPLETE"] = "true";
      envConfig["USE_LOCAL_AI"] = "true";
      envConfig["LOCAL_MODEL_ID"] = "any";
  } else {
      // --- 1. AI CONFIGURATION ---
      console.log(chalk.yellow.bold("[1/3] AI Agent Configuration"));
      
      const aiAnswers = await inquirer.prompt([
        {
          type: "rawlist", // Changed from 'list' for better compatibility
          name: "provider",
          message: "Choose your Primary AI Provider:",
          choices: [
            { name: "Gemini (Google)", value: "gemini" },
            { name: "Claude (Anthropic)", value: "anthropic" },
            { name: "OpenAI (GPT-4o)", value: "openai" },
            { name: "DeepSeek", value: "deepseek" },
            { name: "Grok (xAI)", value: "grok" },
          ],
          default: envConfig["AI_PROVIDER"] || "gemini",
        },
        {
          type: "input", // Changed from 'password' to 'input' to see characters in some terminals
          name: "apiKey",
          message: (answers) => `Enter your ${answers.provider.toUpperCase()} API Key:`,
          validate: (input) => input.length > 0 || "API Key is required.",
        }
      ]);

      const keyVar = `${aiAnswers.provider.toUpperCase()}_API_KEY`;
      envConfig["AI_PROVIDER"] = aiAnswers.provider;
      envConfig[keyVar] = aiAnswers.apiKey;

      // --- 2. LOCAL FALLBACK ---
      console.log(chalk.yellow.bold("\n[2/3] Local LLM Fallback (LM Studio)"));
      
      const fallbackAnswers = await inquirer.prompt([
        {
          type: "confirm",
          name: "useLocal",
          message: "Enable LM Studio as a redundant local fallback?",
          default: envConfig["USE_LOCAL_AI"] === "true",
        },
        {
          type: "input",
          name: "localModel",
          message: "Enter your loaded LM Studio model identifier:",
          default: envConfig["LOCAL_MODEL_ID"] || "llama-3.2-3b-instruct",
          when: (answers) => answers.useLocal,
        }
      ]);

      envConfig["USE_LOCAL_AI"] = fallbackAnswers.useLocal ? "true" : "false";
      if (fallbackAnswers.useLocal) {
        envConfig["LOCAL_MODEL_ID"] = fallbackAnswers.localModel;
      }

      // --- 3. INFRASTRUCTURE ---
      console.log(chalk.yellow.bold("\n[3/3] Infrastructure Configuration"));
      
      const infraAnswers = await inquirer.prompt([
        {
          type: "input",
          name: "solinfraKey",
          message: "Enter SolInfra API Key:",
          default: envConfig["SOLINFRA_API_KEY"] || "",
        },
        {
          type: "rawlist",
          name: "network",
          message: "Target Solana Network:",
          choices: ["testnet", "mainnet-beta"],
          default: envConfig["NETWORK"] || "testnet",
        },
        {
          type: "input",
          name: "jitoUrl",
          message: "Jito Block Engine URL:",
          default: (answers: any) => 
            answers.network === "testnet" 
              ? "ny.testnet.block-engine.jito.wtf" 
              : "ny.mainnet.block-engine.jito.wtf",
        }
      ]);

      envConfig["SOLINFRA_API_KEY"] = infraAnswers.solinfraKey;
      envConfig["NETWORK"] = infraAnswers.network;
      envConfig["BLOCK_ENGINE_URL"] = infraAnswers.jitoUrl;
      envConfig["RPC_URL"] = `https://fra.rpc.solinfra.dev/sol?api_key=${infraAnswers.solinfraKey}`;
      envConfig["GRPC_URL"] = "fra.grpc.solinfra.dev:443";
      envConfig["SETUP_COMPLETE"] = "true";
  }

  // Save .env
  const envContent = Object.entries(envConfig)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(envPath, envContent);

  console.log(chalk.green.bold("\n=================================================="));
  console.log(chalk.green.bold("   SETUP SUCCESSFUL! Project is ready.           "));
  console.log(chalk.green.bold("=================================================="));
  console.log(`\nRun the stack: ${chalk.bold("npm start")}`);
}

main().catch((err) => {
  console.error(chalk.red("\n[Fatal Error] Setup failed:"), err.message);
  process.exit(1);
});
