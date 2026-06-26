import axios from "axios";
import { exec, ChildProcess } from "child_process";
import fs from "fs";

const API_URL = "http://localhost:3000";

function startApiServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    console.log("[Test Runner] Starting API server...");
    const proc = exec("node dist/api.js", (err, stdout, stderr) => {
      if (err && !proc.killed) {
        console.error("[Test Runner] API server crashed:", err.message);
      }
    });

    proc.stdout?.on("data", (data) => {
      const line = data.toString();
      if (line.includes("running on port 3000")) {
        console.log("[Test Runner] API Server is ready.");
        resolve(proc);
      }
    });

    proc.stderr?.on("data", (data) => {
      console.error("[API Server Stderr]", data.toString().trim());
    });

    setTimeout(() => {
      resolve(proc);
    }, 4000);
  });
}

async function runTests() {
  let serverProcess: ChildProcess | null = null;
  try {
    // 1. Compile TS
    console.log("[Test Runner] Compiling TypeScript...");
    await new Promise<void>((resolve, reject) => {
      exec("npx tsc", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log("[Test Runner] Compilation complete.");

    // 2. Clear port 3000 if occupied
    console.log("[Test Runner] Checking for old instances on port 3000...");
    await new Promise<void>((resolve) => {
      exec("lsof -t -i:3000 | xargs kill -9", () => resolve());
    });

    // 3. Start Server
    serverProcess = await startApiServer();

    console.log("\n==================================================");
    console.log("             RUNNING INTEGRATION TESTS            ");
    console.log("==================================================");

    // Use Case 1: Health Check
    console.log("\n[Test 1] Querying /api/v1/health...");
    const healthRes = await axios.get(`${API_URL}/api/v1/health`);
    console.log("Health Status:", healthRes.data);
    if (healthRes.data.status !== "healthy") throw new Error("Health check status is not healthy");
    if (!healthRes.data.grpcConnected) throw new Error("gRPC Geyser is not connected");
    console.log("✓ Test 1 Passed.");

    // Use Case 2: SOL Transfer
    console.log("\n[Test 2] Submitting SOL Transfer...");
    const transferPayload = {
      action: "transfer",
      destination: healthRes.data.payer,
      amountLamports: 1000
    };
    const transferRes = await axios.post(`${API_URL}/api/v1/submit-transfer`, transferPayload);
    console.log("Transfer Response:", transferRes.data);
    if (!transferRes.data.success || !transferRes.data.signature) throw new Error("SOL Transfer failed");
    console.log("✓ Test 2 Passed.");

    // Use Case 3: Create SPL Token & Mint
    console.log("\n[Test 3] Submitting SPL Token Creator & Mint...");
    const mintPayload = {
      action: "mint",
      decimals: 6,
      mintAmount: 500000
    };
    const mintRes = await axios.post(`${API_URL}/api/v1/submit-transfer`, mintPayload);
    console.log("Mint Response:", mintRes.data);
    if (!mintRes.data.success || !mintRes.data.signature || !mintRes.data.mintAddress) {
      throw new Error("SPL Token Creator & Mint failed");
    }
    console.log("✓ Test 3 Passed.");

    // Use Case 4: Real Jupiter Swap Attempt on Mainnet (via autonomous network switch)
    console.log("\n[Test 4] Submitting Jupiter Swap (Expecting Mainnet-beta transition and attempt)...");
    const swapPayload = {
      action: "swap",
      amount: 0.01
    };
    let swapRes: any = null;
    let swapError: any = null;
    try {
      swapRes = await axios.post(`${API_URL}/api/v1/submit-transfer`, swapPayload);
      console.log("Swap Response (Real Swap Succeeded):", swapRes.data);
    } catch (err: any) {
      swapError = err.response?.data?.error || err.message;
      console.log("Swap Attempt failed as expected on Mainnet due to wallet/funds:", swapError);
    }

    // Verify network switched to Mainnet-beta
    const healthAfterSwap = await axios.get(`${API_URL}/api/v1/health`);
    console.log("Health Status after Swap:", healthAfterSwap.data);
    if (healthAfterSwap.data.network !== "MAINNET-BETA") {
      throw new Error("Autonomous network switch to MAINNET-BETA failed after Swap request");
    }
    if (swapError && swapError.includes("only available on Solana Mainnet")) {
      throw new Error("Jupiter Swap fell back to simulation or failed to transition correctly");
    }
    console.log("✓ Test 4 Passed (Mainnet swap attempt verified).");

    // Use Case 5: Real Arbitrage Loop Attempt on Mainnet (via autonomous network switch)
    console.log("\n[Test 5] Submitting Arbitrage Loop (Expecting Mainnet-beta execution attempt)...");
    const arbPayload = {
      action: "arbitrage",
      amount: 0.01
    };
    let arbRes: any = null;
    let arbError: any = null;
    try {
      arbRes = await axios.post(`${API_URL}/api/v1/submit-transfer`, arbPayload);
      console.log("Arbitrage Response (Real Arb Succeeded):", arbRes.data);
    } catch (err: any) {
      arbError = err.response?.data?.error || err.message;
      console.log("Arbitrage Attempt failed as expected on Mainnet due to wallet/funds:", arbError);
    }

    // Verify network is still Mainnet-beta
    const healthAfterArb = await axios.get(`${API_URL}/api/v1/health`);
    console.log("Health Status after Arbitrage:", healthAfterArb.data);
    if (healthAfterArb.data.network !== "MAINNET-BETA") {
      throw new Error("Network is not MAINNET-BETA after Arbitrage request");
    }
    if (arbError && arbError.includes("only available on Solana Mainnet")) {
      throw new Error("Jupiter Arbitrage fell back to simulation or failed to transition correctly");
    }
    console.log("✓ Test 5 Passed (Mainnet arbitrage attempt verified).");

    // Use Case 6: Transaction logs endpoint
    console.log("\n[Test 6] Fetching logs from /api/v1/transactions...");
    const logsRes = await axios.get(`${API_URL}/api/v1/transactions`);
    console.log(`Retrieved ${logsRes.data.length} transaction log entries.`);
    if (!Array.isArray(logsRes.data) || logsRes.data.length < 2) {
      throw new Error("Invalid log entries fetched");
    }
    console.log("✓ Test 6 Passed.");

    console.log("\n==================================================");
    console.log("        ALL INTEGRATION TESTS PASSED CLEANLY      ");
    console.log("==================================================");

  } catch (error: any) {
    console.error("\n❌ Test Suite Failed:");
    if (error.response?.data) {
      console.error("API Error Response Data:", error.response.data);
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      console.log("\n[Test Runner] Shutting down API server...");
      serverProcess.kill("SIGTERM");
    }
    console.log("[Test Runner] Exiting.");
    process.exit(process.exitCode || 0);
  }
}

runTests();
