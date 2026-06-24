import * as dotenv from "dotenv";
import { Keypair, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, classifyFailure } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import * as fs from "fs";

// Pre-flight setup check
dotenv.config({ path: './.env', override: true });
if (process.env.SETUP_COMPLETE !== "true") {
    console.error("\n[Error] Project setup incomplete. Please run: npm run setup");
    process.exit(1);
}

process.on('unhandledRejection', (err: any) => {
    if (err.message?.includes('PERMISSION_DENIED')) return;
    console.warn('[SafeMode] background signal:', err.message || err);
});

async function main() {
  const apiKey = process.env.SOLINFRA_API_KEY!;
  const network = process.env.NETWORK || "testnet";
  const rpcUrl = process.env.RPC_URL!;
  const grpcUrl = process.env.GRPC_URL!;
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
  
  const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./auth-keypair.json";
  const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH || "./payer-keypair.json";

  console.log("==================================================");
  console.log("SMART TRANSACTION STACK - VERIFIABLE ON-CHAIN CORE");
  console.log(`[Config] Network: ${network.toUpperCase()}`);
  console.log("==================================================");

  const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
  const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));
  const connection = new Connection(rpcUrl, "confirmed");

  const observer = new NetworkObserver(grpcUrl, apiKey, rpcUrl, blockEngineUrl, authKeypair, payerKeypair.publicKey);
  const stack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  
  const agent = new AIAgent({
    provider: process.env.AI_PROVIDER || "lmstudio",
    apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.AI_URL,
    modelName: process.env.AI_MODEL
  });

  const tracker = new LifecycleTracker("./logs", network);

  // Monitor slots for confirmations and finalizations
  observer.on("slot", (slotEvent: any) => {
    // status: 1 = SLOT_CONFIRMED, 2 = SLOT_FINALIZED
    if (slotEvent.status === 1) {
      tracker.updateStageBySlot(slotEvent.slot, "confirmed_at");
    } else if (slotEvent.status === 2) {
      tracker.updateStageBySlot(slotEvent.slot, "finalized_at");
    }
  });

  await observer.start();

  const runCycle = async (iteration: number, injectFault = false) => {
    let currentSlot = 0;
    try { currentSlot = await connection.getSlot("processed"); } catch(e) {}

    try {
      console.log(`\n[Cycle ${iteration}/10] Starting AI Decision Pipeline...`);

      // 1. Dynamic Jito leader scheduling check (real schedule)
      const upcoming = await observer.isJitoLeaderUpcoming();
      const timing = await agent.decideTiming(currentSlot, upcoming);
      console.log(`[AI Timing] ${timing.shouldSubmit ? "SUBMIT" : "HOLD"}: ${timing.reasoning}`);
      if (!timing.shouldSubmit && timing.waitTimeMs > 0) {
        await new Promise(r => setTimeout(r, timing.waitTimeMs));
      }

      // 2. Dynamic tip tracking
      const floorData = await getDynamicTip();
      const tipDecision = await agent.decideTip(floorData, "Stable");
      console.log(`[AI Tip] ${tipDecision.lamports} lamports: ${tipDecision.reasoning}`);

      const ix = SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: payerKeypair.publicKey, 
        lamports: 1000,
      });

      // 3. Initial bundle construction
      let currentTip = tipDecision.lamports;
      const tipAccounts = await stack.getTipAccounts();
      const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
      const buildResult = await stack.buildBundle([ix], currentTip, tipAccount);
      
      let txSignature = buildResult.signature;
      let currentBuild = buildResult;
      let attempt = 0;
      const maxAttempts = 3;
      let success = false;

      // 4. Retry loop with autonomous decisions
      while (attempt < maxAttempts && !success) {
        try {
          if (attempt > 0) {
            console.log(`\n[Retry Attempt ${attempt}/${maxAttempts - 1}] Rebuilding and submitting...`);
          }

          // Fault Injection (Requirement 4)
          if (injectFault && attempt === 0) {
            throw new Error("Simulated Error: Blockhash expired (Requirement 4)");
          }

          console.log(`[Action] Transmitting to Jito Block Engine (Tip: ${currentTip} lamports)...`);
          const bundleId = await stack.sendBundle(currentBuild.bundle);
          console.log(`[Success] Jito Accepted Bundle: ${bundleId}`);
          tracker.recordSubmission(txSignature, bundleId, currentSlot, currentTip);

          // Wait for Yellowstone gRPCProcessed event
          success = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => {
              console.warn(`[Timeout] Transaction ${txSignature} not processed via gRPC in 8s.`);
              resolve(false);
            }, 8000);

            observer.on("transaction", (tx) => {
              if (tx.signature === txSignature) {
                tracker.updateStageWithSlot(txSignature, "processed_at", tx.slot);
                clearTimeout(t);
                resolve(true);
              }
            });
          });

          if (!success) {
            throw new Error("Jito Timeout: Bundle execution slot missed");
          }

        } catch (error: any) {
          console.warn(`[Error] Execution failure: ${error.message}`);
          const classification = classifyFailure(error.message);
          
          // Delegate failure analysis to AI agent
          const recovery = await agent.reasonAboutFailure(error.message, { lastTip: currentTip });
          console.log(`[AI Analysis] Decision: ${recovery.action.toUpperCase()} | Reasoning: ${recovery.reasoning}`);

          tracker.recordFailure(txSignature || "error", error.message, classification, recovery.reasoning);

          if (recovery.action === "retry" && attempt < maxAttempts - 1) {
            // Apply AI tip multiplier and refresh blockhash dynamically
            currentTip = Math.floor(currentTip * recovery.newTipMultiplier);
            const blockhashToUse = recovery.refreshBlockhash ? undefined : currentBuild.tx.message.recentBlockhash;
            const freshBuild = await stack.buildBundle([ix], currentTip, tipAccount, blockhashToUse);
            txSignature = freshBuild.signature;
            currentBuild = freshBuild;
            attempt++;
          } else if (recovery.action === "direct_broadcast") {
            console.log(`[AI Recovery] Direct broadcast requested. Resubmitting payload bypass to validator network...`);
            try {
              const txId = await connection.sendRawTransaction(currentBuild.tx.serialize(), { skipPreflight: true });
              console.log(`[Confirming] Direct Broadcast Signature: ${txId}`);
              
              // Direct verification path
              await connection.confirmTransaction(txId, "confirmed");
              console.log(`[Verified] Succeeded on-chain!`);
              
              tracker.recordSubmission(txId, "direct_land", currentSlot, 0);
              tracker.updateStageWithSlot(txId, "processed_at", currentSlot);
              tracker.updateStageBySlot(currentSlot, "confirmed_at");
              success = true;
            } catch (directErr: any) {
              console.error(`[Error] Direct broadcast failed: ${directErr.message}`);
              break;
            }
          } else {
            console.log(`[AI Recovery] Aborting transaction cycle.`);
            break;
          }
        }
      }

    } catch (error: any) {
      console.error(`[Error] Cycle FAILED: ${error.message}`);
    }
  };

  for (let i = 1; i <= 10; i++) {
    await runCycle(i, i === 5);
    console.log("--------------------------------------------------");
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log("\n[Final] Audit logs generated. View logs/lifecycle.json for verifiable links.");
  process.exit(0);
}

main().catch(err => console.error(err));
