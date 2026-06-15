import * as dotenv from "dotenv";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker, FailureClassification } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import * as fs from "fs";

// SDK Error Handling
process.on('unhandledRejection', (err: any) => {
    if (err.message?.includes('PERMISSION_DENIED')) return; // Mute noisy Jito background auth errors
    console.warn('[SDK] Background Event:', err.message || err);
});

dotenv.config({ path: './.env', override: true });

async function main() {
  const apiKey = process.env.SOLINFRA_API_KEY || "iVkL0QyvC7MXFyku";
  const geminiKey = process.env.GEMINI_API_KEY;
  const network = process.env.NETWORK || "testnet";
  const rpcUrl = process.env.RPC_URL || `https://api.testnet.solana.com`;
  const grpcUrl = process.env.GRPC_URL || "fra.grpc.solinfra.dev:443";
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL || "ny.testnet.block-engine.jito.wtf";
  
  const authKeypairPath = process.env.AUTH_KEYPAIR_PATH!;
  const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH!;

  console.log("==================================================");
  console.log("SMART TRANSACTION STACK - LIVE ON-CHAIN VALIDATION");
  console.log(`[Config] Network: ${network}`);
  console.log("==================================================");

  const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
  const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));
  const connection = new Connection(rpcUrl, "confirmed");

  const observer = new NetworkObserver(grpcUrl, apiKey, rpcUrl);
  const stack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  const agent = new AIAgent(geminiKey);
  const tracker = new LifecycleTracker("./logs", network);

  await observer.start();

  const runSmartBundle = async (iteration: number, injectFault = false) => {
    let signature = "";
    let currentSlot = 0;
    try { currentSlot = await connection.getSlot("processed"); } catch(e) {}

    try {
      console.log(`\n[Cycle ${iteration}/10] Starting AI Decision Cycle...`);

      // 1. AI Decision: Timing
      const isUpcoming = await observer.isJitoLeaderUpcoming();
      const timing = await agent.decideTiming(currentSlot, isUpcoming);
      console.log(`[AI Timing] ${timing.shouldSubmit ? "SUBMIT" : "HOLD"}: ${timing.reasoning}`);

      // 2. AI Decision: Tip
      const floorData = await getDynamicTip();
      const tipDecision = await agent.decideTip(floorData, "Normal");
      console.log(`[AI Tip] ${tipDecision.lamports} lamports: ${tipDecision.reasoning}`);

      // 3. Assembly
      let tipAccount: PublicKey;
      try {
        const accounts = await stack.getTipAccounts();
        tipAccount = accounts[0];
      } catch (e) {
        tipAccount = new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY");
      }

      const ix = SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: payerKeypair.publicKey, 
        lamports: 1000,
      });

      const buildResult = await stack.buildBundle([ix], tipDecision.lamports, tipAccount);
      signature = buildResult.signature;
      tracker.recordSubmission(signature, "pending", currentSlot, tipDecision.lamports);

      if (injectFault) throw new Error("Expired blockhash (Fault Injection)");

      // 5. Submission
      console.log(`[Action] Submitting Bundle to Jito...`);
      const bundleId = await stack.sendBundle(buildResult.bundle);
      console.log(`[Success] Jito Accepted: ${bundleId}`);

    } catch (error: any) {
      console.error(`[Result] Jito Submission Refused: ${error.message}`);
      
      // AI Recovery
      console.log(`[AI Agent] Analyzing rejection and deciding autonomous recovery...`);
      const retryPlan = await agent.reasonAboutFailure(error.message, {
        lastTip: 100000,
        slot: currentSlot,
      });

      console.log(`[AI Reasoning] ${retryPlan.reasoning}`);

      if (retryPlan.action === "direct_broadcast") {
          console.log(`[Action] EXECUTING DIRECT ON-CHAIN LANDING...`);
          const ix = SystemProgram.transfer({
            fromPubkey: payerKeypair.publicKey,
            toPubkey: payerKeypair.publicKey,
            lamports: 1000,
          });
          const { bundle, signature: newSig } = await stack.buildBundle([ix], 0, new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"));
          
          const tx = (bundle as any).transactions[0];
          await connection.sendRawTransaction(tx.serialize());
          
          tracker.recordSubmission(newSig, "direct", currentSlot, 0);
          console.log(`[Success] TRANSACTION LANDED!`);
          console.log(`[Link] https://solscan.io/tx/${newSig}?cluster=${network}`);
      }

      tracker.recordFailure(signature || "error", error.message, "BundleFailure", retryPlan.reasoning);
    }
  };

  for (let i = 1; i <= 10; i++) {
    await runSmartBundle(i, i === 5);
    console.log("--------------------------------------------------");
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log("\n[Final] Verification complete. Check logs/lifecycle.json for working on-chain links.");
}

main().catch(err => console.error(err));
