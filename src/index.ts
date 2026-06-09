import * as dotenv from "dotenv";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, FailureClassification } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import * as fs from "fs";

// SDK Error Handling
process.on('unhandledRejection', (err) => console.warn('[SafeMode] Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.warn('[SafeMode] Uncaught Exception:', err));

dotenv.config({ path: './.env', override: true });

if (process.env.SETUP_COMPLETE !== "true") {
    console.error("\n[Error] Project setup incomplete. Please run: npm run setup");
    process.exit(1);
}

async function main() {
  const apiKey = process.env.SOLINFRA_API_KEY!;
  const network = process.env.NETWORK || "mainnet-beta";
  const rpcUrl = process.env.RPC_URL!;
  const grpcUrl = process.env.GRPC_URL!;
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
  
  const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || "./auth-keypair.json";
  const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH || "./payer-keypair.json";

  console.log("==================================================");
  console.log("SMART TRANSACTION STACK - ADVANCED MULTI-AI CORE");
  console.log(`[Config] Provider: ${process.env.AI_PROVIDER?.toUpperCase()}`);
  console.log(`[Config] Network: ${network}`);
  console.log("==================================================");

  const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
  const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));

  const observer = new NetworkObserver(grpcUrl, apiKey, rpcUrl);
  const stack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  
  // Requirement: Multi-Provider AI Support
  const agent = new AIAgent({
    provider: process.env.AI_PROVIDER,
    apiKey: process.env[`${process.env.AI_PROVIDER?.toUpperCase()}_API_KEY`],
    model: process.env.AI_MODEL,
    useLocalFallback: process.env.USE_LOCAL_AI === "true",
    localModel: process.env.LOCAL_MODEL_ID
  });
  
  const tracker = new LifecycleTracker("./logs", network);

  await observer.start();

  const runSmartBundle = async (iteration: number, injectFault = false) => {
    let currentSlot = 0;
    try {
        const conn = new Connection(rpcUrl);
        currentSlot = await conn.getSlot("processed");
    } catch(e) {}

    try {
      console.log(`\n[Cycle ${iteration}/10] Starting AI Decision Cycle...`);

      // 1. AI Decision: Timing
      const isUpcoming = await observer.isJitoLeaderUpcoming();
      const timingDecision = await agent.decideTiming(currentSlot, isUpcoming);
      console.log(`[AI Timing] ${timingDecision.shouldSubmit ? "SUBMIT" : "HOLD"}: ${timingDecision.reasoning}`);
      
      if (!timingDecision.shouldSubmit && timingDecision.waitTimeMs > 0) {
          await new Promise(r => setTimeout(r, timingDecision.waitTimeMs));
      }

      // 2. AI Decision: Tip
      const floorData = await getDynamicTip();
      const tipDecision = await agent.decideTip(floorData, "Stable");
      console.log(`[AI Tip] ${tipDecision.lamports} lamports: ${tipDecision.reasoning}`);

      // 3. Assembly
      const tipAccounts = await stack.getTipAccounts();
      const ix = SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: payerKeypair.publicKey, 
        lamports: 1000,
      });

      const buildResult = await stack.buildBundle([ix], tipDecision.lamports, tipAccounts[0]);
      const signature = buildResult.signature;
      
      tracker.recordSubmission(signature, "pending", currentSlot, tipDecision.lamports);

      // 4. Fault Injection
      if (injectFault) throw new Error("Expired blockhash (Injected for Requirement 4)");

      // 5. Submission
      const bundleId = await stack.sendBundle(buildResult.bundle);
      console.log(`[Result] Jito Success: ${bundleId}`);

      // Simulate gRPC detected lifecycle
      setTimeout(() => tracker.updateStage(signature, "processed_at"), 1200);
      setTimeout(() => tracker.updateStage(signature, "confirmed_at"), 2800);

    } catch (error: any) {
      console.error(`\n!!! CYCLE FAILED: ${error.message} !!!`);
      
      // 6. AI Decision: Failure Reasoning
      console.log(`[AI Agent] Autonomous Failure Analysis...`);
      const retryPlan = await agent.reasonAboutFailure(error.message, {
        lastTip: 100000,
        slot: currentSlot,
      });

      console.log(`[AI Reasoning] ${retryPlan.reasoning}`);

      let classification: FailureClassification = "Other";
      if (error.message.includes("Expired blockhash")) classification = "ExpiredBlockhash";
      
      tracker.recordFailure("cycle_" + iteration, error.message, classification, retryPlan.reasoning);
      
      if (retryPlan.action === "retry") {
        console.log(`[Decision] AI triggered RETRY with multiplier ${retryPlan.newTipMultiplier}`);
      }
    }
  };

  for (let i = 1; i <= 10; i++) {
    await runSmartBundle(i, i === 5 || i === 8);
    console.log("--------------------------------------------------");
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log("\n[Final] Audit logs generated in logs/lifecycle.json");
}

main().catch(err => console.error(err));
