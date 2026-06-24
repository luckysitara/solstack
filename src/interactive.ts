import * as dotenv from "dotenv";
import { Keypair, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, classifyFailure } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs";

dotenv.config({ path: './.env', override: true });

async function runInteractive() {
  console.clear();
  console.log(chalk.bold.cyan("=================================================="));
  console.log(chalk.bold.cyan("   SOLSTACK - INTERACTIVE TRANSACTION LIFECYCLE   "));
  console.log(chalk.bold.cyan("=================================================="));

  const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./auth-keypair.json";
  const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH || "./payer-keypair.json";

  if (!fs.existsSync(authKeypairPath) || !fs.existsSync(payerKeypairPath)) {
    console.error(chalk.red("[Error] Payer or Auth keypair files missing. Run setup first."));
    process.exit(1);
  }

  const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
  const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));
  
  const rpcUrl = process.env.RPC_URL!;
  const grpcUrl = process.env.GRPC_URL!;
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
  const apiKey = process.env.SOLINFRA_API_KEY!;
  const network = process.env.NETWORK || "testnet";

  const connection = new Connection(rpcUrl, "confirmed");

  console.log(chalk.green(`✓ Payer Wallet Loaded: `) + chalk.yellow(payerKeypair.publicKey.toBase58()));
  console.log(chalk.green(`✓ RPC Connection: `) + chalk.yellow(rpcUrl));
  console.log(chalk.green(`✓ Geyser gRPC Endpoint: `) + chalk.yellow(grpcUrl));
  console.log("");

  // Prompt user for interactive setup
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "provider",
      message: "Select AI Cognitive Provider:",
      choices: ["lmstudio", "anthropic", "ollama", "gemini", "openai", "deepseek"],
      default: process.env.AI_PROVIDER || "lmstudio"
    },
    {
      type: "input",
      name: "destination",
      message: "Enter Destination Wallet Address:",
      default: payerKeypair.publicKey.toBase58(),
      validate: (input) => {
        try {
          new PublicKey(input);
          return true;
        } catch (e) {
          return "Invalid Solana Public Key format.";
        }
      }
    },
    {
      type: "input",
      name: "amount",
      message: "Enter SOL Amount to Transfer:",
      default: "0.001",
      validate: (input) => {
        const val = parseFloat(input);
        return (!isNaN(val) && val > 0) ? true : "Must be a positive numeric value.";
      }
    }
  ]);

  const destPubkey = new PublicKey(answers.destination);
  const amountLamports = Math.floor(parseFloat(answers.amount) * 1_000_000_000);

  console.log(chalk.cyan("\nInitializing systems... Please wait."));
  
  const observer = new NetworkObserver(grpcUrl, apiKey, rpcUrl, blockEngineUrl, authKeypair, payerKeypair.publicKey);
  const stack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  const agent = new AIAgent({
    provider: answers.provider,
    apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.AI_URL,
    modelName: process.env.AI_MODEL
  });
  const tracker = new LifecycleTracker("./logs", network);

  // Set up listeners for the live slot tracker
  let liveSlot = 0;
  observer.on("slot", (slotEvent: any) => {
    liveSlot = slotEvent.slot;
    if (slotEvent.status === 1) {
      tracker.updateStageBySlot(slotEvent.slot, "confirmed_at");
    } else if (slotEvent.status === 2) {
      tracker.updateStageBySlot(slotEvent.slot, "finalized_at");
    }
  });

  await observer.start();

  console.clear();
  console.log(chalk.bold.magenta("=================================================="));
  console.log(chalk.bold.magenta("        SOLSTACK LIVE COGNITIVE TRANSACTOR        "));
  console.log(chalk.bold.magenta("=================================================="));
  console.log(chalk.gray("Press Ctrl+C to abort and exit at any time."));
  console.log("--------------------------------------------------");

  const updatePanel = async () => {
    console.log(chalk.blue(`[Live Slot] `) + chalk.bold.white(liveSlot || "Waiting for Geyser stream..."));
    
    // Check Jito Leader Upcoming Status
    const upcoming = await observer.isJitoLeaderUpcoming();
    const leaderStatusStr = upcoming 
      ? chalk.bold.green("★ JITO LEADER UPCOMING (Priority Slot Alert) ★")
      : chalk.gray("Standard Slot (No Jito Leader immediately scheduled)");
    console.log(chalk.blue(`[Leader Status] `) + leaderStatusStr);
  };

  // Interval to update slot panel
  const panelInterval = setInterval(updatePanel, 1000);

  // Run a single manual cycle based on user input
  const executeCycle = async () => {
    clearInterval(panelInterval);
    console.log("\n--------------------------------------------------");
    console.log(chalk.cyan("Starting AI optimization pipeline..."));

    let currentSlot = 0;
    try {
      currentSlot = await connection.getSlot("processed");
    } catch (e) {}

    // 1. AI timing decision
    const upcoming = await observer.isJitoLeaderUpcoming();
    console.log(chalk.yellow("[AI Query] Querying AI timing decision..."));
    const timing = await agent.decideTiming(currentSlot, upcoming);
    console.log(chalk.green(`[AI Timing Decision] `) + chalk.white(`${timing.shouldSubmit ? "SUBMIT" : "HOLD"} | Reasoning: ${timing.reasoning}`));
    
    if (!timing.shouldSubmit && timing.waitTimeMs > 0) {
      console.log(chalk.yellow(`[AI Timing] Holding submission for ${timing.waitTimeMs}ms...`));
      await new Promise(r => setTimeout(r, timing.waitTimeMs));
    }

    // 2. AI tipping decision
    console.log(chalk.yellow("[AI Query] Querying AI Jito tip decision..."));
    const floorData = await getDynamicTip();
    const tipDecision = await agent.decideTip(floorData, "Stable");
    console.log(chalk.green(`[AI Tip Decision] `) + chalk.white(`${tipDecision.lamports} lamports | Reasoning: ${tipDecision.reasoning}`));

    // 3. Assemble and Submit Bundle
    const ix = SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: destPubkey,
      lamports: amountLamports,
    });

    let currentTip = tipDecision.lamports;
    const tipAccounts = await stack.getTipAccounts();
    const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    const buildResult = await stack.buildBundle([ix], currentTip, tipAccount);
    
    let txSignature = buildResult.signature;
    let currentBuild = buildResult;
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    let txHash = "";

    while (attempt < maxAttempts && !success) {
      try {
        if (attempt > 0) {
          console.log(chalk.yellow(`\n[Attempt ${attempt + 1}/${maxAttempts}] Rebuilding transaction bundle...`));
        }

        console.log(chalk.cyan(`[Action] Submitting bundle to Jito Block Engine (Tip: ${currentTip} lamports)...`));
        const bundleId = await stack.sendBundle(currentBuild.bundle);
        console.log(chalk.green(`✓ Jito Block Engine Accepted Bundle! ID: `) + chalk.yellow(bundleId));
        tracker.recordSubmission(txSignature, bundleId, currentSlot, currentTip);
        txHash = txSignature;

        console.log(chalk.yellow("⌛ Awaiting landing verification via Yellowstone Geyser stream..."));
        
        success = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            console.warn(chalk.red(`[Timeout] Jito Block Engine bundle landing missed.`));
            resolve(false);
          }, 8000);

          const txListener = (tx: any) => {
            if (tx.signature === txSignature) {
              observer.off("transaction", txListener);
              clearTimeout(t);
              resolve(true);
            }
          };
          observer.on("transaction", txListener);
        });

        if (!success) {
          throw new Error("Jito Timeout: Bundle execution slot missed");
        }

      } catch (error: any) {
        console.warn(chalk.red(`[Error] Execution failure: ${error.message}`));
        const classification = classifyFailure(error.message);
        
        // Consult AI for recovery strategy
        console.log(chalk.yellow("[AI Query] Analyzing failure via AI agent..."));
        const recovery = await agent.reasonAboutFailure(error.message, { lastTip: currentTip });
        console.log(chalk.green(`[AI Recovery Decision] `) + chalk.white(`${recovery.action.toUpperCase()} | Reasoning: ${recovery.reasoning}`));
        tracker.recordFailure(txSignature || "error", error.message, classification, recovery.reasoning);

        if (recovery.action === "retry" && attempt < maxAttempts - 1) {
          currentTip = Math.floor(currentTip * recovery.newTipMultiplier);
          const blockhashToUse = recovery.refreshBlockhash ? undefined : currentBuild.tx.message.recentBlockhash;
          const freshBuild = await stack.buildBundle([ix], currentTip, tipAccount, blockhashToUse);
          txSignature = freshBuild.signature;
          currentBuild = freshBuild;
          attempt++;
        } else if (recovery.action === "direct_broadcast") {
          console.log(chalk.cyan(`[AI Recovery] Executing Direct Broadcast. Resubmitting payload bypass to RPC...`));
          try {
            const txId = await connection.sendRawTransaction(currentBuild.tx.serialize(), { skipPreflight: true });
            console.log(chalk.yellow(`[Confirming] Direct Broadcast Signature: `) + chalk.white(txId));
            
            await connection.confirmTransaction(txId, "confirmed");
            console.log(chalk.green(`✓ Direct Broadcast Confirmed Succeeded on-chain!`));
            
            tracker.recordSubmission(txId, "direct_land", currentSlot, 0);
            tracker.updateStageWithSlot(txId, "processed_at", currentSlot);
            tracker.updateStageBySlot(currentSlot, "confirmed_at");
            txHash = txId;
            success = true;
          } catch (directErr: any) {
            console.error(chalk.red(`[Error] Direct broadcast failed: ${directErr.message}`));
            break;
          }
        } else {
          console.log(chalk.red("[AI Recovery] Aborting transaction cycle."));
          break;
        }
      }
    }

    console.log("--------------------------------------------------");
    if (success) {
      console.log(chalk.bold.green("✓ TRANSACTION COMPLETED SUCCESSFULLY!"));
      console.log(chalk.cyan("Signature: ") + chalk.white(txHash));
      const clusterParam = network === "mainnet" ? "" : `?cluster=${network}`;
      console.log(chalk.cyan("Solscan URL: ") + chalk.white(`https://solscan.io/tx/${txHash}${clusterParam}`));
    } else {
      console.log(chalk.bold.red("✗ TRANSACTION LIFECYCLE FAILED TO COMPLETE"));
    }
    console.log("--------------------------------------------------");

    // Re-prompt to start another or exit
    const action = await inquirer.prompt([
      {
        type: "confirm",
        name: "continue",
        message: "Would you like to execute another transaction?",
        default: true
      }
    ]);

    if (action.continue) {
      console.clear();
      console.log(chalk.bold.magenta("=================================================="));
      console.log(chalk.bold.magenta("        SOLSTACK LIVE COGNITIVE TRANSACTOR        "));
      console.log(chalk.bold.magenta("=================================================="));
      // Restart updater panel
      setInterval(updatePanel, 1000);
      executeCycle();
    } else {
      console.log(chalk.green("\nThank you for using Solstack. Exiting."));
      process.exit(0);
    }
  };

  // Wait 3 seconds to let Geyser slots update before starting the loop
  setTimeout(executeCycle, 3000);
}

runInteractive().catch(err => {
  console.error("Fatal interactive runtime error:", err);
  process.exit(1);
});
