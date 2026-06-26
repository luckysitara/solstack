import * as dotenv from "dotenv";
import { Keypair, SystemProgram, PublicKey, Connection, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack, createConnectionWithTimeout } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, classifyFailure } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import { buildTokenCreationInstructions } from "./utils/token.js";
import { fetchJupiterQuote, fetchJupiterSwapTransaction, fetchRealArbitrageTransactions } from "./utils/jupiter.js";
import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs";

dotenv.config({ path: './.env', override: true });

process.on('unhandledRejection', (err: any) => {
    if (err.message?.includes('PERMISSION_DENIED')) return;
    console.warn('[SafeMode] background signal:', err.message || err);
});

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
  let currentNetwork = process.env.NETWORK || "testnet";

  let currentConnection = createConnectionWithTimeout(rpcUrl, "confirmed");

  console.log(chalk.green(`✓ Payer Wallet Loaded: `) + chalk.yellow(payerKeypair.publicKey.toBase58()));
  console.log(chalk.green(`✓ RPC Connection: `) + chalk.yellow(rpcUrl));
  console.log(chalk.green(`✓ Geyser gRPC Endpoint: `) + chalk.yellow(grpcUrl));
  console.log("");

  // Prompt user for interactive setup
  const initialAnswers = await inquirer.prompt([
    {
      type: "select",
      name: "provider",
      message: "Select AI Cognitive Provider:",
      choices: ["lmstudio", "anthropic", "ollama", "gemini", "openai", "deepseek"],
      default: process.env.AI_PROVIDER || "lmstudio"
    },
    {
      type: "select",
      name: "action",
      message: "Select Transaction Operation:",
      choices: [
        "SOL Transfer",
        "Create SPL Token & Mint",
        "Jupiter Token Swap (SOL -> USDC)",
        "Arbitrage Loop (SOL -> USDC -> SOL)"
      ],
      default: "SOL Transfer"
    }
  ]);

  const action = initialAnswers.action;
  let actionParams: any = {};

  if (action === "SOL Transfer") {
    actionParams = await inquirer.prompt([
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
  } else if (action === "Create SPL Token & Mint") {
    actionParams = await inquirer.prompt([
      {
        type: "input",
        name: "decimals",
        message: "Enter Token Decimals:",
        default: "9",
        validate: (input) => {
          const val = parseInt(input, 10);
          return (!isNaN(val) && val >= 0 && val <= 18) ? true : "Must be an integer between 0 and 18.";
        }
      },
      {
        type: "input",
        name: "mintAmount",
        message: "Enter Amount of Tokens to Mint:",
        default: "1000000",
        validate: (input) => {
          const val = parseFloat(input);
          return (!isNaN(val) && val > 0) ? true : "Must be a positive number.";
        }
      }
    ]);
  } else {
    actionParams = await inquirer.prompt([
      {
        type: "input",
        name: "amount",
        message: "Enter SOL Amount to Swap:",
        default: "0.01",
        validate: (input) => {
          const val = parseFloat(input);
          return (!isNaN(val) && val > 0) ? true : "Must be a positive numeric value.";
        }
      }
    ]);
  }

  console.log(chalk.cyan("\nInitializing systems... Please wait."));
  
  // Initialize Subsystems
  let currentObserver = new NetworkObserver(grpcUrl, apiKey, rpcUrl, blockEngineUrl, authKeypair, [payerKeypair.publicKey.toBase58()]);
  let currentStack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  const agent = new AIAgent({
    provider: initialAnswers.provider,
    apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.AI_URL,
    modelName: process.env.AI_MODEL
  });
  let currentTracker = new LifecycleTracker("./logs", currentNetwork);

  async function performNetworkSwitch(targetNetwork: string) {
    if (currentNetwork === targetNetwork) return;
    console.log(chalk.cyan(`\n[CLI Network] Switch network to: ${targetNetwork.toUpperCase()}`));
    
    // Stop current observer
    await currentObserver.stop();

    // Determine config parameters for new network
    currentNetwork = targetNetwork;
    let targetRpcUrl = "";
    let targetGrpcUrl = "";
    let targetBlockEngineUrl = "";
    let targetGrpcApiKey = "";

    if (targetNetwork === "testnet") {
      targetRpcUrl = "https://api.testnet.solana.com";
      targetGrpcUrl = "https://solana-testnet-yellowstone-grpc.publicnode.com:443";
      targetBlockEngineUrl = "ny.testnet.block-engine.jito.wtf";
      targetGrpcApiKey = "";
    } else if (targetNetwork === "devnet") {
      targetRpcUrl = "https://api.devnet.solana.com";
      targetGrpcUrl = "https://solana-devnet-yellowstone-grpc.publicnode.com:443";
      targetBlockEngineUrl = "dallas.devnet.block-engine.jito.wtf";
      targetGrpcApiKey = "";
    } else { // mainnet-beta / mainnet
      const mainnetRpc = process.env.MAINNET_RPC_URL || "";
      const mainnetGrpc = process.env.MAINNET_GRPC_URL || "";
      const envRpc = process.env.RPC_URL || "";
      const envGrpc = process.env.GRPC_URL || "";

      if (mainnetRpc) {
        targetRpcUrl = mainnetRpc;
      } else if (process.env.SOLINFRA_API_KEY) {
        targetRpcUrl = `https://fra.rpc.solinfra.dev/sol?api_key=${process.env.SOLINFRA_API_KEY}`;
      } else if (envRpc && !envRpc.includes("testnet") && !envRpc.includes("devnet")) {
        targetRpcUrl = envRpc;
      } else {
        targetRpcUrl = "https://solana-mainnet-rpc.publicnode.com";
      }

      if (mainnetGrpc) {
        targetGrpcUrl = mainnetGrpc;
        targetGrpcApiKey = process.env.MAINNET_GRPC_API_KEY || "";
      } else if (process.env.SOLINFRA_API_KEY) {
        targetGrpcUrl = "https://fra.grpc.solinfra.dev:443";
        targetGrpcApiKey = process.env.SOLINFRA_API_KEY;
      } else if (envGrpc && !envGrpc.includes("testnet") && !envGrpc.includes("devnet")) {
        targetGrpcUrl = envGrpc;
        targetGrpcApiKey = "";
      } else {
        targetGrpcUrl = "https://solana-yellowstone-grpc.publicnode.com:443";
        targetGrpcApiKey = "";
      }

      targetBlockEngineUrl = "ny.mainnet.block-engine.jito.wtf";
    }

    // Prepend https:// protocol if missing from target gRPC URL to enable SSL connection in client
    if (targetGrpcUrl && !targetGrpcUrl.startsWith("http://") && !targetGrpcUrl.startsWith("https://")) {
      targetGrpcUrl = "https://" + targetGrpcUrl;
    }

    console.log(chalk.gray(`[CLI Network] New RPC: ${targetRpcUrl}`));
    console.log(chalk.gray(`[CLI Network] New gRPC: ${targetGrpcUrl}`));
    console.log(chalk.gray(`[CLI Network] New Block Engine: ${targetBlockEngineUrl}`));

    // Re-initialize instances
    currentConnection = createConnectionWithTimeout(targetRpcUrl, "confirmed");
    currentObserver = new NetworkObserver(targetGrpcUrl, targetGrpcApiKey, targetRpcUrl, targetBlockEngineUrl, authKeypair, [payerKeypair.publicKey.toBase58()]);
    currentStack = new TransactionStack(targetRpcUrl, targetBlockEngineUrl, authKeypair, payerKeypair);
    currentTracker = new LifecycleTracker("./logs", currentNetwork);
    liveSlot = 0;

    // Re-attach observer event handlers
    currentObserver.on("slot", (slotEvent: any) => {
      liveSlot = slotEvent.slot;
      if (slotEvent.status === 1) {
        currentTracker.updateStageBySlot(slotEvent.slot, "confirmed_at");
      } else if (slotEvent.status === 2) {
        currentTracker.updateStageBySlot(slotEvent.slot, "finalized_at");
      }
    });

    // Start new observer
    await currentObserver.start();
  }

  // Set up listeners for the live slot tracker
  let liveSlot = 0;
  currentObserver.on("slot", (slotEvent: any) => {
    liveSlot = slotEvent.slot;
    if (slotEvent.status === 1) {
      currentTracker.updateStageBySlot(slotEvent.slot, "confirmed_at");
    } else if (slotEvent.status === 2) {
      currentTracker.updateStageBySlot(slotEvent.slot, "finalized_at");
    }
  });

  await currentObserver.start();

  let currentInterval: NodeJS.Timeout | null = null;

  const updatePanel = async () => {
    console.log(chalk.blue(`[Live Slot] `) + chalk.bold.white(liveSlot || "Waiting for Geyser stream..."));
    
    // Check Jito Leader Upcoming Status
    const upcoming = await currentObserver.isJitoLeaderUpcoming();
    const leaderStatusStr = upcoming 
      ? chalk.bold.green("★ JITO LEADER UPCOMING (Priority Slot Alert) ★")
      : chalk.gray("Standard Slot (No Jito Leader immediately scheduled)");
    console.log(chalk.blue(`[Leader Status] `) + leaderStatusStr);
  };

  const runCycleWithDelay = () => {
    if (currentInterval) {
      clearInterval(currentInterval);
    }
    console.clear();
    console.log(chalk.bold.magenta("=================================================="));
    console.log(chalk.bold.magenta("        SOLSTACK LIVE COGNITIVE TRANSACTOR        "));
    console.log(chalk.bold.magenta("=================================================="));
    console.log(chalk.gray("Press Ctrl+C to abort and exit at any time."));
    console.log("--------------------------------------------------");
    
    currentInterval = setInterval(updatePanel, 1000);
    
    setTimeout(async () => {
      if (currentInterval) {
        clearInterval(currentInterval);
        currentInterval = null;
      }
      await executeCycle();
    }, 3000);
  };

  // Run a single manual cycle based on user input
  const executeCycle = async () => {
    // 0. Network Switch check for Swap and Arbitrage operations
    if (action === "Jupiter Token Swap (SOL -> USDC)" || action === "Arbitrage Loop (SOL -> USDC -> SOL)") {
      if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
        try {
          await performNetworkSwitch("mainnet-beta");
        } catch (switchErr: any) {
          console.error(chalk.red(`[Error] Autonomous network switch to mainnet-beta failed: ${switchErr.message}`));
          console.log("--------------------------------------------------");
          console.log(chalk.bold.red("✗ TRANSACTION LIFECYCLE FAILED TO COMPLETE"));
          console.log("--------------------------------------------------");
          await promptNextCycle();
          return;
        }
      }
    }

    const tipAccounts = await currentStack.getTipAccounts();
    const selectedTipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

    console.log("\n--------------------------------------------------");
    console.log(chalk.cyan("Starting AI optimization pipeline..."));

    let currentSlot = liveSlot > 0 ? liveSlot : 429000000;
    try {
      currentSlot = await currentConnection.getSlot("processed");
    } catch (e) {}

    // 1. AI timing decision
    const upcoming = await currentObserver.isJitoLeaderUpcoming();
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
    let currentTip = tipDecision.lamports;
    let txSignature = "";
    let currentBuild: any = null;
    let tokenSetup: any = null;
    let swapTx: any = null;
    let arb: any = null;

    const buildInitialBundle = async (tipVal: number) => {
      if (action === "SOL Transfer") {
        const destPubkey = new PublicKey(actionParams.destination);
        const amountLamports = Math.floor(parseFloat(actionParams.amount) * 1_000_000_000);
        currentObserver.addWatchAccount(destPubkey.toBase58());
        const ix = SystemProgram.transfer({
          fromPubkey: payerKeypair.publicKey,
          toPubkey: destPubkey,
          lamports: amountLamports,
        });
        return await currentStack.buildBundle([ix], tipVal, selectedTipAccount);
      } else if (action === "Create SPL Token & Mint") {
        console.log(chalk.cyan("Compiling SPL Token creation and minting instructions..."));
        tokenSetup = await buildTokenCreationInstructions(
          currentConnection,
          payerKeypair.publicKey,
          parseInt(actionParams.decimals, 10),
          parseFloat(actionParams.mintAmount)
        );
        console.log(chalk.green(`✓ Generated Mint Address: `) + chalk.yellow(tokenSetup.mintPubkey.toBase58()));
        currentObserver.addWatchAccount(tokenSetup.mintPubkey.toBase58());
        currentObserver.addWatchAccount(tokenSetup.ataPubkey.toBase58());
        return await currentStack.buildBundle(
          tokenSetup.instructions,
          tipVal,
          selectedTipAccount,
          tokenSetup.signers
        );
      } else if (action === "Jupiter Token Swap (SOL -> USDC)") {
        if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
          throw new Error("Jupiter Swap is only available on Solana Mainnet.");
        }
        console.log(chalk.cyan("Fetching Jupiter quote for SOL -> USDC swap..."));
        const swapAmountLamports = Math.floor(parseFloat(actionParams.amount) * 1_000_000_000);
        const quote = await fetchJupiterQuote(
          "So11111111111111111111111111111111111111112", // WSOL
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
          swapAmountLamports
        );
        console.log(chalk.green(`✓ Jupiter Quote Fetched. Expected Out: ${quote.outAmount} USDC`));
        swapTx = await fetchJupiterSwapTransaction(quote, payerKeypair.publicKey);
        
        swapTx.sign([payerKeypair]);
        const buildRes = await currentStack.buildBundleFromTransactions(
          [swapTx],
          tipVal,
          selectedTipAccount
        );
        return {
          bundle: buildRes.bundle,
          signature: buildRes.signature,
          tx: swapTx
        };
      } else {
        // Arbitrage Loop
        if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
          throw new Error("Jupiter Arbitrage is only available on Solana Mainnet.");
        }
        console.log(chalk.cyan("Fetching real-time arbitrage quote loop from Jupiter..."));
        const startAmount = Math.floor(parseFloat(actionParams.amount) * 1_000_000_000);
        arb = await fetchRealArbitrageTransactions(payerKeypair.publicKey, startAmount);
        
        console.log(chalk.green(`✓ Leg 1 Quote (SOL->USDC) expected out: ${arb.quote1.outAmount} USDC`));
        console.log(chalk.green(`✓ Leg 2 Quote (USDC->SOL) expected out: ${arb.quote2.outAmount} lamports`));
        
        const expectedProfit = BigInt(arb.quote2.outAmount) - BigInt(startAmount);
        console.log(chalk.yellow(`Expected Profit/Loss: ${expectedProfit.toString()} lamports`));

        arb.tx1.sign([payerKeypair]);
        arb.tx2.sign([payerKeypair]);

        const buildRes = await currentStack.buildBundleFromTransactions(
          [arb.tx1, arb.tx2],
          tipVal,
          selectedTipAccount
        );
        return {
          bundle: buildRes.bundle,
          signature: buildRes.signature,
          tx: arb.tx1
        };
      }
    };

    try {
      const buildResult = await buildInitialBundle(currentTip);
      txSignature = buildResult.signature;
      currentBuild = buildResult;
    } catch (buildErr: any) {
      console.error(chalk.red(`[Error] Failed to assemble bundle: ${buildErr.message}`));
      console.log("--------------------------------------------------");
      console.log(chalk.bold.red("✗ TRANSACTION LIFECYCLE FAILED TO COMPLETE"));
      console.log("--------------------------------------------------");
      await promptNextCycle();
      return;
    }

    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    let txHash = "";

    while (attempt < maxAttempts && !success) {
      try {
        if (attempt > 0) {
          console.log(chalk.yellow(`\n[Attempt ${attempt + 1}/${maxAttempts}] Rebuilding transaction bundle...`));
          if (action === "SOL Transfer" || action === "Create SPL Token & Mint") {
            const rebuildResult = await buildInitialBundle(currentTip);
            txSignature = rebuildResult.signature;
            currentBuild = rebuildResult;
          } else if (action === "Jupiter Token Swap (SOL -> USDC)") {
            const buildRes = await currentStack.buildBundleFromTransactions([swapTx], currentTip, selectedTipAccount);
            txSignature = buildRes.signature;
            currentBuild = { bundle: buildRes.bundle, signature: buildRes.signature, tx: swapTx };
          } else {
            const buildRes = await currentStack.buildBundleFromTransactions([arb.tx1, arb.tx2], currentTip, selectedTipAccount);
            txSignature = buildRes.signature;
            currentBuild = { bundle: buildRes.bundle, signature: buildRes.signature, tx: arb.tx1 };
          }
        }

        console.log(chalk.cyan(`[Action] Submitting bundle to Jito Block Engine (Tip: ${currentTip} lamports)...`));
        const bundleId = await currentStack.sendBundle(currentBuild.bundle);
        console.log(chalk.green(`✓ Jito Block Engine Accepted Bundle! ID: `) + chalk.yellow(bundleId));
        currentTracker.recordSubmission(txSignature, bundleId, currentSlot, currentTip);
        txHash = txSignature;

        console.log(chalk.yellow("⌛ Awaiting landing verification via Yellowstone Geyser stream..."));
        
        success = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            console.warn(chalk.red(`[Timeout] Jito Block Engine bundle landing missed.`));
            resolve(false);
          }, 8000);

          const txListener = (tx: any) => {
            if (tx.signature === txSignature) {
              currentObserver.off("transaction", txListener);
              clearTimeout(t);
              resolve(true);
            }
          };
          currentObserver.on("transaction", txListener);
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
        currentTracker.recordFailure(txSignature || "error", error.message, classification, recovery.reasoning);

        if (recovery.action === "retry" && attempt < maxAttempts - 1) {
          currentTip = Math.floor(currentTip * recovery.newTipMultiplier);
          attempt++;
        } else if (recovery.action === "direct_broadcast") {
          console.log(chalk.cyan(`[AI Recovery] Executing Direct Broadcast. Resubmitting payload bypass to RPC...`));
          try {
            const txId = await currentConnection.sendRawTransaction(currentBuild.tx.serialize(), { skipPreflight: true });
            console.log(chalk.yellow(`[Confirming] Direct Broadcast Signature: `) + chalk.white(txId));
            
            await currentConnection.confirmTransaction(txId, "confirmed");
            console.log(chalk.green(`✓ Direct Broadcast Confirmed Succeeded on-chain!`));
            
            currentTracker.recordSubmission(txId, "direct_land", currentSlot, 0);
            currentTracker.updateStageWithSlot(txId, "processed_at", currentSlot);
            currentTracker.updateStageBySlot(currentSlot, "confirmed_at");
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
      const clusterParam = currentNetwork === "mainnet" ? "" : `?cluster=${currentNetwork}`;
      console.log(chalk.cyan("Solscan URL: ") + chalk.white(`https://solscan.io/tx/${txHash}${clusterParam}`));
    } else {
      console.log(chalk.bold.red("✗ TRANSACTION LIFECYCLE FAILED TO COMPLETE"));
    }
    console.log("--------------------------------------------------");

    await promptNextCycle();
  };

  const promptNextCycle = async () => {
    // Re-prompt to start another or exit
    const loopAction = await inquirer.prompt([
      {
        type: "confirm",
        name: "continue",
        message: "Would you like to execute another transaction?",
        default: true
      }
    ]);

    if (loopAction.continue) {
      runCycleWithDelay();
    } else {
      console.log(chalk.green("\nThank you for using Solstack. Exiting."));
      process.exit(0);
    }
  };

  // Start the interactive cycle
  runCycleWithDelay();
}

runInteractive().catch(err => {
  console.error("Fatal interactive runtime error:", err);
  process.exit(1);
});
