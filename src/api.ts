import express from "express";
import * as dotenv from "dotenv";
import { Keypair, SystemProgram, PublicKey, Connection, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack, createConnectionWithTimeout } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, classifyFailure } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import { buildTokenCreationInstructions } from "./utils/token.js";
import { fetchJupiterQuote, fetchJupiterSwapTransaction, fetchRealArbitrageTransactions } from "./utils/jupiter.js";
import * as fs from "fs";

dotenv.config({ path: './.env', override: true });

process.on('unhandledRejection', (err: any) => {
    if (err.message?.includes('PERMISSION_DENIED')) return;
    console.warn('[SafeMode] background signal:', err.message || err);
});

const app = express();
app.use(express.json());

// Enable CORS for UI integrations
app.use((req: any, res: any, next: any) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const port = process.env.PORT || 3000;
const network = process.env.NETWORK || "testnet";
const apiKey = process.env.SOLINFRA_API_KEY || "";
let rpcUrl = process.env.RPC_URL || "";
if (rpcUrl.includes("publicnode.com") && apiKey && !rpcUrl.endsWith(apiKey)) {
  rpcUrl = rpcUrl.replace(/\/$/, "") + "/" + apiKey;
}
const grpcUrl = process.env.GRPC_URL!;
const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./auth-keypair.json";
const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH || "./payer-keypair.json";

console.log("[API Server] Initializing PrismaAI Transaction Relay Subsystems...");

const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));

let currentNetwork = network;
let currentRpcUrl = rpcUrl;
let connection = createConnectionWithTimeout(currentRpcUrl, "confirmed");

// Determine initial gRPC API key based on network
let initialGrpcApiKey = "";
if (currentNetwork === "testnet" || currentNetwork === "devnet") {
  initialGrpcApiKey = "";
} else {
  initialGrpcApiKey = process.env.MAINNET_GRPC_API_KEY || process.env.SOLINFRA_API_KEY || "";
}

// Initialize Observation, Execution, Intelligence, and Tracker SDKs
let observer = new NetworkObserver(grpcUrl, initialGrpcApiKey, currentRpcUrl, blockEngineUrl, authKeypair, [payerKeypair.publicKey.toBase58()]);
let stack = new TransactionStack(currentRpcUrl, blockEngineUrl, authKeypair, payerKeypair);
const agent = new AIAgent({
  provider: process.env.AI_PROVIDER || "lmstudio",
  apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.AI_URL,
  modelName: process.env.AI_MODEL
});
let tracker = new LifecycleTracker("./logs", currentNetwork);
let latestGeyserSlot = 0;

// Attach Geyser Streams Helper
function attachObserverListeners(obs: NetworkObserver, trk: LifecycleTracker) {
  obs.on("slot", (slotEvent: any) => {
    if (slotEvent.slot > latestGeyserSlot) {
      latestGeyserSlot = slotEvent.slot;
    }
    if (slotEvent.status === 1) {
      trk.updateStageBySlot(slotEvent.slot, "confirmed_at");
    } else if (slotEvent.status === 2) {
      trk.updateStageBySlot(slotEvent.slot, "finalized_at");
    }
  });

  obs.on("transaction", (tx) => {
    trk.updateStageWithSlot(tx.signature, "processed_at", tx.slot);
  });
}

// Attach initial listeners
attachObserverListeners(observer, tracker);

// Start Geyser Stream Client
observer.start().catch((err) => {
  console.error("[API Server] Geyser observer failed to start:", err.message);
});

// Health check endpoint
app.get("/api/v1/health", (req: any, res: any) => {
  return res.json({
    status: "healthy",
    network: currentNetwork.toUpperCase(),
    payer: payerKeypair.publicKey.toBase58(),
    grpcConnected: !observer.isStopped
  });
});

// Transaction logs endpoint
app.get("/api/v1/transactions", (req: any, res: any) => {
  try {
    const logPath = "./logs/lifecycle.json";
    if (fs.existsSync(logPath)) {
      const data = fs.readFileSync(logPath, "utf-8");
      return res.json(JSON.parse(data));
    }
    return res.json([]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

async function performNetworkSwitch(targetNetwork: string) {
  if (currentNetwork === targetNetwork) return;
  console.log(`\n[API Network] Switch network to: ${targetNetwork.toUpperCase()}`);
  
  // Stop current observer
  await observer.stop();

  // Determine config parameters for new network
  currentNetwork = targetNetwork;
  let targetRpcUrl = "";
  let targetGrpcUrl = "";
  let targetBlockEngineUrl = "";
  let targetGrpcApiKey = "";

  if (targetNetwork === "testnet") {
    const key = process.env.SOLINFRA_API_KEY || "";
    targetRpcUrl = key ? `https://solana-testnet-rpc.publicnode.com/${key}` : "https://solana-testnet-rpc.publicnode.com";
    targetGrpcUrl = "solana-testnet-yellowstone-grpc.publicnode.com:443";
    targetBlockEngineUrl = "ny.testnet.block-engine.jito.wtf";
    targetGrpcApiKey = "";
  } else if (targetNetwork === "devnet") {
    targetRpcUrl = "https://api.devnet.solana.com";
    targetGrpcUrl = "solana-devnet-yellowstone-grpc.publicnode.com:443";
    targetBlockEngineUrl = "dallas.devnet.block-engine.jito.wtf";
    targetGrpcApiKey = "";
  } else { // mainnet-beta / mainnet
    const mainnetRpc = process.env.MAINNET_RPC_URL || "";
    const mainnetGrpc = process.env.MAINNET_GRPC_URL || "";
    const envRpc = process.env.RPC_URL || "";
    const envGrpc = process.env.GRPC_URL || "";
    const key = process.env.SOLINFRA_API_KEY || "";

    if (mainnetRpc) {
      targetRpcUrl = mainnetRpc;
    } else if (key) {
      targetRpcUrl = `https://solana-rpc.publicnode.com/${key}`;
    } else if (envRpc && !envRpc.includes("testnet") && !envRpc.includes("devnet")) {
      targetRpcUrl = envRpc;
    } else {
      targetRpcUrl = "https://solana-mainnet-rpc.publicnode.com";
    }

    if (mainnetGrpc) {
      targetGrpcUrl = mainnetGrpc;
      targetGrpcApiKey = process.env.MAINNET_GRPC_API_KEY || "";
    } else if (envGrpc && !envGrpc.includes("testnet") && !envGrpc.includes("devnet")) {
      targetGrpcUrl = envGrpc;
      targetGrpcApiKey = "";
    } else {
      targetGrpcUrl = "solana-yellowstone-grpc.publicnode.com:443";
      targetGrpcApiKey = "";
    }

    targetBlockEngineUrl = "ny.mainnet.block-engine.jito.wtf";
  }

  // Prepend https:// protocol if missing from target gRPC URL to enable SSL connection in client
  if (targetGrpcUrl && !targetGrpcUrl.startsWith("http://") && !targetGrpcUrl.startsWith("https://")) {
    targetGrpcUrl = "https://" + targetGrpcUrl;
  }

  console.log(`[API Network] New RPC: ${targetRpcUrl}`);
  console.log(`[API Network] New gRPC: ${targetGrpcUrl}`);
  console.log(`[API Network] New Block Engine: ${targetBlockEngineUrl}`);

  // Re-initialize instances
  connection = createConnectionWithTimeout(targetRpcUrl, "confirmed");
  observer = new NetworkObserver(targetGrpcUrl, targetGrpcApiKey, targetRpcUrl, targetBlockEngineUrl, authKeypair, [payerKeypair.publicKey.toBase58()]);
  stack = new TransactionStack(targetRpcUrl, targetBlockEngineUrl, authKeypair, payerKeypair);
  tracker = new LifecycleTracker("./logs", currentNetwork);
  latestGeyserSlot = 0;

  // Re-attach observer event handlers
  attachObserverListeners(observer, tracker);

  // Start new observer
  await observer.start();
}

// Switch network endpoint
app.post("/api/v1/network", async (req: express.Request, res: express.Response) => {
  const { network: targetNetwork } = req.body;
  if (!["testnet", "devnet", "mainnet-beta"].includes(targetNetwork)) {
    return res.status(400).json({ error: "Invalid network. Must be 'testnet', 'devnet', or 'mainnet-beta'" });
  }

  try {
    await performNetworkSwitch(targetNetwork);
    return res.status(200).json({
      success: true,
      network: currentNetwork,
      rpcUrl: connection.rpcEndpoint,
      grpcConnected: true
    });
  } catch (error: any) {
    console.error(`[API Server Error] Network switch failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Submit transfer endpoint
app.post("/api/v1/submit-transfer", async (req: express.Request, res: express.Response) => {
  const { action = "transfer", destination, amountLamports, decimals = 9, mintAmount = 1000000, amount } = req.body;

  if (action === "transfer") {
    if (!destination || typeof amountLamports !== "number" || amountLamports <= 0) {
      return res.status(400).json({ error: "Invalid parameters. Require destination (string) and amountLamports (number > 0)" });
    }
  } else if (action === "mint") {
    // Mint parameters are optional and have defaults
  } else {
    // swap or arbitrage
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid parameters. Require amount (number > 0) representing SOL input" });
    }
  }

  if (action === "swap" || action === "arbitrage") {
    if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
      try {
        await performNetworkSwitch("mainnet-beta");
      } catch (switchErr: any) {
        return res.status(500).json({ success: false, error: `Autonomous network switch to mainnet-beta failed: ${switchErr.message}` });
      }
    }
  }

  let currentSlot = latestGeyserSlot > 0 ? latestGeyserSlot : 429000000;
  try {
    currentSlot = await connection.getSlot("processed");
  } catch (e) {}

  try {
    console.log(`\n[API Endpoint] Incoming request: action=${action}`);

    const tipAccounts = await stack.getTipAccounts();
    const selectedTipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

    // 1. AI timing decision
    const upcoming = await observer.isJitoLeaderUpcoming();
    const timing = await agent.decideTiming(currentSlot, upcoming);
    console.log(`[AI Timing] ${timing.shouldSubmit ? "SUBMIT" : "HOLD"}: ${timing.reasoning}`);
    
    if (!timing.shouldSubmit && timing.waitTimeMs > 0) {
      console.log(`[AI Timing] Holding submission for ${timing.waitTimeMs}ms...`);
      await new Promise(r => setTimeout(r, timing.waitTimeMs));
    }

    // 2. AI tipping decision
    const floorData = await getDynamicTip();
    const tipDecision = await agent.decideTip(floorData, "Stable");
    console.log(`[AI Tip] ${tipDecision.lamports} lamports: ${tipDecision.reasoning}`);

    // 3. Compile and Build initial bundle
    let currentTip = tipDecision.lamports;
    let txSignature = "";
    let currentBuild: any = null;
    let tokenSetup: any = null;
    let swapTx: any = null;
    let arb: any = null;

    const buildInitialBundle = async (tipVal: number) => {
      if (action === "transfer") {
        const destPubkey = new PublicKey(destination);
        observer.addWatchAccount(destPubkey.toBase58());
        const ix = SystemProgram.transfer({
          fromPubkey: payerKeypair.publicKey,
          toPubkey: destPubkey,
          lamports: amountLamports,
        });
        return await stack.buildBundle([ix], tipVal, selectedTipAccount);
      } else if (action === "mint") {
        console.log(`[API Mint] Compiling SPL Token creation and minting instructions...`);
        tokenSetup = await buildTokenCreationInstructions(
          connection,
          payerKeypair.publicKey,
          Number(decimals),
          Number(mintAmount)
        );
        observer.addWatchAccount(tokenSetup.mintPubkey.toBase58());
        observer.addWatchAccount(tokenSetup.ataPubkey.toBase58());
        return await stack.buildBundle(
          tokenSetup.instructions,
          tipVal,
          selectedTipAccount,
          tokenSetup.signers
        );
      } else if (action === "swap") {
        if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
          throw new Error("Jupiter Swap is only available on Solana Mainnet.");
        }
        const swapAmountLamports = Math.floor(amount * 1_000_000_000);
        const quote = await fetchJupiterQuote(
          "So11111111111111111111111111111111111111112", // WSOL
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
          swapAmountLamports
        );
        swapTx = await fetchJupiterSwapTransaction(quote, payerKeypair.publicKey);
        swapTx.sign([payerKeypair]);
        const buildRes = await stack.buildBundleFromTransactions(
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
        // arbitrage
        if (currentNetwork !== "mainnet-beta" && currentNetwork !== "mainnet") {
          throw new Error("Jupiter Arbitrage is only available on Solana Mainnet.");
        }
        const startAmount = Math.floor(amount * 1_000_000_000);
        arb = await fetchRealArbitrageTransactions(payerKeypair.publicKey, startAmount);
        arb.tx1.sign([payerKeypair]);
        arb.tx2.sign([payerKeypair]);
        const buildRes = await stack.buildBundleFromTransactions(
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
      console.error(`[API Server Error] Failed to assemble bundle: ${buildErr.message}`);
      return res.status(500).json({ success: false, error: buildErr.message });
    }
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    let txHash = "";

    let recovery: any = null;

    // 4. Retry loop with AI exception recovery
    while (attempt < maxAttempts && !success) {
      try {
        if (attempt > 0) {
          console.log(`[Retry Attempt ${attempt}/${maxAttempts - 1}] Rebuilding bundle...`);
          const blockhashToUse = (recovery && !recovery.refreshBlockhash) ? (currentBuild.tx?.message?.recentBlockhash || currentBuild.tx?.recentBlockhash) : undefined;
          if (action === "transfer") {
            const destPubkey = new PublicKey(destination);
            const ix = SystemProgram.transfer({
              fromPubkey: payerKeypair.publicKey,
              toPubkey: destPubkey,
              lamports: amountLamports,
            });
            currentBuild = await stack.buildBundle([ix], currentTip, selectedTipAccount, [], blockhashToUse);
            txSignature = currentBuild.signature;
          } else if (action === "mint") {
            currentBuild = await stack.buildBundle(
              tokenSetup.instructions,
              currentTip,
              selectedTipAccount,
              tokenSetup.signers,
              blockhashToUse
            );
            txSignature = currentBuild.signature;
          } else if (action === "swap") {
            const buildRes = await stack.buildBundleFromTransactions([swapTx], currentTip, selectedTipAccount);
            txSignature = buildRes.signature;
            currentBuild = { bundle: buildRes.bundle, signature: buildRes.signature, tx: swapTx };
          } else {
            const buildRes = await stack.buildBundleFromTransactions([arb.tx1, arb.tx2], currentTip, selectedTipAccount);
            txSignature = buildRes.signature;
            currentBuild = { bundle: buildRes.bundle, signature: buildRes.signature, tx: arb.tx1 };
          }
        }

        console.log(`[Action] Submitting bundle to Jito Block Engine (Tip: ${currentTip} lamports)...`);
        const bundleId = await stack.sendBundle(currentBuild.bundle);
        console.log(`[Success] Jito Block Engine Accepted Bundle: ${bundleId}`);
        tracker.recordSubmission(txSignature, bundleId, currentSlot, currentTip);
        txHash = txSignature;

        // Await confirmation via Geyser stream
        success = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            console.warn(`[Timeout] Transaction not processed via gRPC Geyser stream in 8s.`);
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
        console.warn(`[Error] Execution failure: ${error.message}`);
        const classification = classifyFailure(error.message);
        
        // Consult AI for recovery strategy
        const recovery = await agent.reasonAboutFailure(error.message, { lastTip: currentTip });
        console.log(`[AI Analysis] Decision: ${recovery.action.toUpperCase()} | Reasoning: ${recovery.reasoning}`);
        tracker.recordFailure(txSignature || "error", error.message, classification, recovery.reasoning);

        if (recovery.action === "retry" && attempt < maxAttempts - 1) {
          currentTip = Math.floor(currentTip * recovery.newTipMultiplier);
          attempt++;
        } else if (recovery.action === "direct_broadcast") {
          console.log(`[AI Recovery] Direct broadcast requested. Resubmitting bypass to RPC...`);
          try {
            const txId = await connection.sendRawTransaction(currentBuild.tx.serialize(), { skipPreflight: true });
            console.log(`[Confirming] Direct Broadcast Signature: ${txId}`);
            
            await connection.confirmTransaction(txId, "confirmed");
            console.log(`[Verified] Direct Broadcast Succeeded on-chain!`);
            
            tracker.recordSubmission(txId, "direct_land", currentSlot, 0);
            tracker.updateStageWithSlot(txId, "processed_at", currentSlot);
            tracker.updateStageBySlot(currentSlot, "confirmed_at");
            txHash = txId;
            success = true;
          } catch (directErr: any) {
            console.error(`[Error] Direct broadcast failed: ${directErr.message}`);
            break;
          }
        } else {
          console.log("[AI Recovery] Aborting transaction cycle.");
          break;
        }
      }
    }

    if (success) {
      const clusterParam = currentNetwork === "mainnet" ? "" : `?cluster=${currentNetwork}`;
      const solscanUrl = `https://solscan.io/tx/${txHash}${clusterParam}`;
      const resPayload: any = {
        success: true,
        signature: txHash,
        solscanUrl,
        timingDecision: timing,
        tipDecision
      };
      if (action === "mint" && tokenSetup) {
        resPayload.mintAddress = tokenSetup.mintPubkey.toBase58();
        resPayload.ataAddress = tokenSetup.ataPubkey.toBase58();
      }
      return res.status(200).json(resPayload);
    } else {
      return res.status(500).json({
        success: false,
        error: "Failed to land transaction after max retry attempts"
      });
    }

  } catch (error: any) {
    console.error(`[API Server Error] Execution failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`[API Server] PrismaAI Transaction Relay API running on port ${port}`);
});
