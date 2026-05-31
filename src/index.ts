import * as dotenv from "dotenv";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey } from "@solana/web3.js";
import { NetworkObserver } from "./observer.js";
import { TransactionStack } from "./stack.js";
import { AIAgent } from "./agent.js";
import { LifecycleTracker } from "./tracker.js";
import { getDynamicTip } from "./utils/tip.js";
import * as fs from "fs";

dotenv.config();

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const grpcUrl = process.env.GRPC_URL!;
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL!;
  const authKeypairPath = process.env.AUTH_KEYPAIR_PATH!;
  const payerKeypairPath = process.env.PAYER_KEYPAIR_PATH!;
  
  // Default to LM Studio if no cloud provider is specified
  const aiType = process.env.AI_PROVIDER || "lmstudio";
  const geminiKey = process.env.GEMINI_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  console.log("--------------------------------------------------");
  console.log(`[Config] AI Provider: ${aiType.toUpperCase()}`);
  if (aiType === "lmstudio") {
      console.log("[Config] Local AI selected - No API key required.");
  }
  console.log("--------------------------------------------------");

  const authKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authKeypairPath, "utf-8"))));
  const payerKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))));

  const observer = new NetworkObserver(grpcUrl);
  const stack = new TransactionStack(rpcUrl, blockEngineUrl, authKeypair, payerKeypair);
  const agent = new AIAgent(aiType, { 
    apiKey: aiType === "gemini" ? geminiKey : openaiKey,
    model: process.env.AI_MODEL,
    baseURL: process.env.AI_BASE_URL
  });
  const tracker = new LifecycleTracker("./logs");

  console.log("Starting Smart Transaction Stack...");
  
  const runBundle = async (simulatedError?: string) => {
    const signature = "simulated_sig_" + Date.now();
    try {
      const tip = await getDynamicTip("landed_tips_50th_percentile");
      
      console.log(`[Step 1] Dynamic Tip Calculated: ${tip} lamports`);

      if (simulatedError) {
          throw new Error(simulatedError);
      }

      let tipAccount: PublicKey;
      try {
        const tipAccounts = await stack.getTipAccounts();
        tipAccount = tipAccounts[0];
      } catch (e) {
        console.warn("Jito Searcher API error. Using fallback tip account.");
        tipAccount = new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY");
      }

      const ix = SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: payerKeypair.publicKey, 
        lamports: 1000,
      });

      console.log(`[Step 2] Building Bundle...`);
      const bundle = await stack.buildBundle([ix], tip, tipAccount);

      tracker.recordSubmission(signature, 0, tip);
      console.log(`[Step 3] Bundle Recorded: ${signature}`);

      console.log(`[Step 4] Sending Bundle (Simulated result if API fails)...`);
      try {
        const result = await stack.sendBundle(bundle);
        console.log(`Bundle sent to Block Engine: ${result}`);
      } catch (e: any) {
        console.warn("Bundle submission failed:", e.message);
        throw e;
      }

    } catch (error: any) {
      console.error("\n!!! Bundle Cycle Failure Detected !!!");
      console.error("Error Message:", error.message);
      
      console.log(`\n[AI Agent: ${aiType}] Reasoning about failure...`);
      try {
        const retryPlan = await agent.reasonAboutFailure(error.message, {
          lastTip: 100000,
          slot: 123456,
          networkCongestion: "High",
        });

        console.log("AI Agent Reasoning:", retryPlan.reasoning);
        console.log("AI Decision:", retryPlan.action.toUpperCase());
      } catch (aiError: any) {
        console.error("AI Provider failed:", aiError.message);
        console.log("Fallback: Retrying with standard strategy (Refresh blockhash + 10% tip)");
      }
    }
  };

  console.log("\n--- RUN 1: SUCCESS PATH (SIMULATED) ---");
  await runBundle();
  
  console.log("\n--- RUN 2: FAULT INJECTION (EXPIRED BLOCKHASH) ---");
  await runBundle("Blockhash expired");

  console.log("\nTest execution finished. Check logs/lifecycle.json for results.");
}

main().catch(console.error);
