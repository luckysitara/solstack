import express from "express";
import * as dotenv from "dotenv";
import { Keypair, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, classifyFailure } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import * as fs from "fs";

dotenv.config({ path: './.env', override: true });

process.on('unhandledRejection', (err: any) => {
    if (err.message?.includes('PERMISSION_DENIED')) return;
    console.warn('[SafeMode] background signal:', err.message || err);
});

const app = express();
app.use(express.json());

// Enable CORS for UI integrations
app.use((req, res, next) => {
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
const rpcUrl = process.env.RPC_URL!;
const grpcUrl = process.env.GRPC_URL!;
const apiKey = process.env.SOLINFRA_API_KEY!;
const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./auth-keypair.json";
const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH || "./payer-keypair.json";

console.log("[API Server] Initializing PrismaAI Transaction Relay Subsystems...");

const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));

let currentNetwork = network;
let currentRpcUrl = rpcUrl;
let connection = new Connection(currentRpcUrl, "confirmed");

// Initialize Observation, Execution, Intelligence, and Tracker SDKs
let observer = new NetworkObserver(grpcUrl, apiKey, currentRpcUrl, blockEngineUrl, authKeypair);
let stack = new TransactionStack(currentRpcUrl, blockEngineUrl, authKeypair, payerKeypair);
const agent = new AIAgent({
  provider: process.env.AI_PROVIDER || "lmstudio",
  apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.AI_URL,
  modelName: process.env.AI_MODEL
});
let tracker = new LifecycleTracker("./logs", currentNetwork);

// Attach Geyser Streams Helper
function attachObserverListeners(obs: NetworkObserver, trk: LifecycleTracker) {
  obs.on("slot", (slotEvent: any) => {
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
app.get("/api/v1/health", (req, res) => {
  return res.json({
    status: "healthy",
    network: currentNetwork.toUpperCase(),
    payer: payerKeypair.publicKey.toBase58(),
    grpcConnected: !observer.isStopped
  });
});

// Transaction logs endpoint
app.get("/api/v1/transactions", (req, res) => {
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

// Switch network endpoint
app.post("/api/v1/network", async (req: express.Request, res: express.Response) => {
  const { network: targetNetwork } = req.body;
  if (!["testnet", "devnet", "mainnet-beta"].includes(targetNetwork)) {
    return res.status(400).json({ error: "Invalid network. Must be 'testnet', 'devnet', or 'mainnet-beta'" });
  }

  try {
    console.log(`\n[API Endpoint] Switching network to: ${targetNetwork.toUpperCase()}`);
    
    // Stop current observer
    await observer.stop();

    // Determine config parameters for new network
    currentNetwork = targetNetwork;
    let targetRpcUrl = "";
    let targetGrpcUrl = "";
    let targetBlockEngineUrl = "";

    if (targetNetwork === "testnet") {
      targetRpcUrl = "https://api.testnet.solana.com";
      targetGrpcUrl = "solana-testnet-yellowstone-grpc.publicnode.com:443";
      targetBlockEngineUrl = "ny.testnet.block-engine.jito.wtf";
    } else if (targetNetwork === "devnet") {
      targetRpcUrl = "https://api.devnet.solana.com";
      targetGrpcUrl = "solana-devnet-yellowstone-grpc.publicnode.com:443";
      targetBlockEngineUrl = "dallas.devnet.block-engine.jito.wtf";
    } else { // mainnet-beta
      targetRpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
      targetGrpcUrl = process.env.GRPC_URL || "solana-yellowstone-grpc.publicnode.com:443";
      targetBlockEngineUrl = "ny.mainnet.block-engine.jito.wtf";
    }

    console.log(`[API Network] New RPC: ${targetRpcUrl}`);
    console.log(`[API Network] New gRPC: ${targetGrpcUrl}`);
    console.log(`[API Network] New Block Engine: ${targetBlockEngineUrl}`);

    // Re-initialize instances
    connection = new Connection(targetRpcUrl, "confirmed");
    observer = new NetworkObserver(targetGrpcUrl, apiKey, targetRpcUrl, targetBlockEngineUrl, authKeypair);
    stack = new TransactionStack(targetRpcUrl, targetBlockEngineUrl, authKeypair, payerKeypair);
    tracker = new LifecycleTracker("./logs", currentNetwork);

    // Re-attach observer event handlers
    attachObserverListeners(observer, tracker);

    // Start new observer
    await observer.start();

    return res.status(200).json({
      success: true,
      network: currentNetwork,
      rpcUrl: targetRpcUrl,
      grpcConnected: true
    });
  } catch (error: any) {
    console.error(`[API Server Error] Network switch failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Submit transfer endpoint
app.post("/api/v1/submit-transfer", async (req: express.Request, res: express.Response) => {
  const { destination, amountLamports } = req.body;

  if (!destination || typeof amountLamports !== "number" || amountLamports <= 0) {
    return res.status(400).json({ error: "Invalid parameters. Require destination (string) and amountLamports (number > 0)" });
  }

  let currentSlot = 0;
  try {
    currentSlot = await connection.getSlot("processed");
  } catch (e) {}

  try {
    console.log(`\n[API Endpoint] Incoming transfer request of ${amountLamports} lamports to ${destination}`);

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

    // Create the Transfer instruction
    const destPubkey = new PublicKey(destination);
    const ix = SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: destPubkey,
      lamports: amountLamports,
    });

    // 3. Build bundle
    let currentTip = tipDecision.lamports;
    const buildResult = await stack.buildBundle([ix], currentTip, new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"));
    
    let txSignature = buildResult.signature;
    let currentBuild = buildResult;
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    let txHash = "";

    // 4. Retry loop with AI exception recovery
    while (attempt < maxAttempts && !success) {
      try {
        if (attempt > 0) {
          console.log(`[Retry Attempt ${attempt}/${maxAttempts - 1}] Rebuilding bundle...`);
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
          const freshBuild = await stack.buildBundle([ix], currentTip, new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"));
          txSignature = freshBuild.signature;
          currentBuild = freshBuild;
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
      const clusterParam = network === "mainnet" ? "" : `?cluster=${network}`;
      const solscanUrl = `https://solscan.io/tx/${txHash}${clusterParam}`;
      return res.status(200).json({
        success: true,
        signature: txHash,
        solscanUrl,
        timingDecision: timing,
        tipDecision
      });
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
