# PrismaAI: Smart Solana Transaction Stack

A production-grade, high-frequency Solana transaction orchestrator powered by Yellowstone gRPC Geyser streaming, atomic Jito Block Engine bundles, and an autonomous AI Cognitive Engine for error recovery and dynamic tipping.

---

## 1. Problem Statement & Solution

### 1.1 The Problem
Standard Solana applications broadcast transactions blindly to public RPC nodes and poll endpoints (`getSignatureStatuses`) to track landing progress. This model suffers from:
1. **Consensus Latency**: RPC polling takes 400-800ms, which is too slow for time-sensitive transactions like arbitrage, liquidations, or minting.
2. **Capital Drain**: Failed smart-contract transactions (e.g., slipped trade inputs) still consume transaction fees, draining wallet balances.
3. **MEV Exposure**: Publicly broadcast transactions are subject to front-running and sandwich attacks by searchers.
4. **Network Outages**: Standard RPC endpoints quickly rate-limit or fail during periods of intense network congestion.

### 1.2 The Solution
The PrismaAI Transaction Stack replaces legacy infrastructure with:
1. **Sub-millisecond Data Streaming**: Integrates **Triton Yellowstone gRPC** to stream blocks, slots, and signatures directly from the validator's Geyser plugin.
2. **Atomic Execution**: Wraps transactions in **Jito Bundles**. Transactions execute atomically—if simulation fails, the bundle is dropped, and no fee or tip is paid.
3. **Dynamic Tipping**: Queries the live Jito tip floor API in real-time, adapting auction bids to network congestion.
4. **AI-Driven Recovery**: Leverages an **AI Cognitive Engine** (supporting cloud Gemini, Claude, Deepseek, OpenAI, or local LM Studio and Ollama) to analyze failures and autonomously execute recovery paths (e.g., blockhash refreshes, tip multiplication, or direct broadcast bypasses).

---

## 2. Core Subsystems & Components

*   **[NetworkObserver](file:///home/rootkit/solstack/src/observer.ts#L22)** in [observer.ts](file:///home/rootkit/solstack/src/observer.ts): Manages secure HTTP/2 socket connections to Yellowstone gRPC nodes, filters transactions, and tracks the Jito leader schedule.
*   **[TransactionStack](file:///home/rootkit/solstack/src/stack.ts#L13)** in [stack.ts](file:///home/rootkit/solstack/src/stack.ts): Compiles `VersionedTransaction` instances, adds dynamic tip instructions, signs payloads, and submits bundles to the Block Engine.
*   **[AIAgent](file:///home/rootkit/solstack/src/agent.ts#L390)** in [agent.ts](file:///home/rootkit/solstack/src/agent.ts): Evaluates network exceptions, calculates dynamic tips, decides submission timing, and plans retry parameters.
*   **[LifecycleTracker](file:///home/rootkit/solstack/src/tracker.ts#L54)** in [tracker.ts](file:///home/rootkit/solstack/src/tracker.ts): Audits slot numbers, commitment stages (`processed`, `confirmed`, `finalized`), computes latency metrics, and writes records to [logs/lifecycle.json](file:///home/rootkit/solstack/logs/lifecycle.json).
*   **[getDynamicTip](file:///home/rootkit/solstack/src/utils/tip.ts#L16)** in [tip.ts](file:///home/rootkit/solstack/src/utils/tip.ts): Fetches the low-latency landed tips floor directly from Jito's Explorer endpoint.
*   **[index.ts](file:///home/rootkit/solstack/src/index.ts)**: Orchestrates the test execution cycle, simulated fault injection, and fallback handlers.
*   **[interactive.ts](file:///home/rootkit/solstack/src/interactive.ts)**: Implements the live console-based CLI transactor.
*   **[api.ts](file:///home/rootkit/solstack/src/api.ts)**: Exposes the Express REST endpoints connecting the backend transactor to client applications.
*   **[dashboard/](file:///home/rootkit/solstack/dashboard/)**: A beautiful Vite React web application dashboard utilizing glassmorphic aesthetics to control and visualize transaction progressions.

---

## 3. Use Cases
1. **High-Frequency Arbitrage**: Secure blockspace priority via competitive tipping and ensure atomicity to avoid gas loss on slipped prices.
2. **DeFi Liquidations**: Trigger instant liquidation events immediately when a collateral threshold is crossed by observing Geyser price streams and bypassing standard RPC latency.
3. **NFT Sniping / Launchpad Mints**: Target the exact slot a mint goes live using Jito leader schedules.
4. **Real-time Blockchain Indexing**: Feed databases with block and transaction data streamed directly from Geyser shredded block updates.

---

## 4. The AI Cognitive Engine (No Mocking)

The AI layer in PrismaAI is **fully functional, completely unmocked, and dynamically fail-safe**. It does not rely on hardcoded heuristic fallback decisions. Instead, it dynamically prompts the chosen backend with real-time data, requiring detailed reasoning and structured parameters.

1. **Active Multi-Provider Chain**: The agent configures a priority chain of supported AI backends depending on available environment credentials:
   - **Gemini**: `gemini-2.0-flash` model via the Google AI SDK.
   - **Claude**: Anthropic messaging API (`claude-3-5-sonnet-20241022`).
   - **DeepSeek**: DeepSeek chat completions API (`deepseek-chat`).
   - **OpenAI**: OpenAI completions API (`gpt-4o-mini`).
   - **LM Studio**: Local OpenAI-compatible server on port `1234`.
   - **Ollama**: Local Ollama server on port `11434`.
2. **Zero-Hardcoded-Fallback Failover**: If the primary model times out, returns a rate-limit error, or experiences connectivity issues, the stack automatically fails over to the next configured provider in the active chain. If all providers fail, the program errors out rather than defaulting to hardcoded heuristic overrides.
3. **Transparent Execution Logging**: Every request to the AI is logged with the specific active provider class and model identifier (e.g. `[AIAgent] Consulting active provider: GeminiProvider (Model: gemini-2.0-flash)`), giving operators full visibility into which model resolved the decision.

---

## 5. Triage Team / Tester Information

### 5.1 Endpoint Agnosticism & Custom Nodes
All RPC, gRPC, and Block Engine endpoints are fully configurable. **The triage team can use their own gRPC server or Triton nodes.**
* The setup tool (`npm run setup`) supports choosing between **Default SolInfra configuration** or **Custom configuration** (allowing the user to supply custom gRPC URLs, API keys/auth tokens, custom RPC endpoints, and custom block engines).
* Standard Jito Block Engine URLs are preset for Devnet, Testnet, and Mainnet-beta.

### 5.2 Built-in Robustness Safeguards
* **gRPC Connection Protection**: The Geyser stream includes an auto-reconnect loop with exponential backoff.
* **Jito Schedule Timeout**: Leader schedule queries in [observer.ts](file:///home/rootkit/solstack/src/observer.ts#L154) are wrapped in a 2-second timeout, preventing the stack from hanging if the Jito schedule service is offline.
* **Jito Submission Timeout**: gRPC bundle submissions in [stack.ts](file:///home/rootkit/solstack/src/stack.ts#L62) are wrapped in a 3-second timeout. If the Jito block engine does not respond, the stack times out and delegates to the AI, which automatically triggers a `direct_broadcast` on-chain fallback.

---

## 6. Setup & Execution Instructions

### 6.1 Installation
1. Clone the repository and install the dependencies:
   ```bash
   npm install
   ```
2. Generate your keypairs. The stack expects `auth-keypair.json` (for Jito searcher registration) and `payer-keypair.json` (funded wallet):
   ```bash
   # Solana CLI generates id.json
   solana-keygen new --no-passphrase -o payer-keypair.json
   cp payer-keypair.json auth-keypair.json
   ```

### 6.2 Guided Configuration
Start the interactive CLI setup script:
```bash
npm run setup
```
This utility prompts you to configure:
1. **Infrastructure Mode**: Choose between SolInfra defaults or your custom RPC/gRPC/Block Engine endpoints.
2. **Target Network**: Select `testnet`, `devnet`, or `mainnet-beta`.
3. **AI Cognitive Provider**: Select your primary provider (Gemini, Claude, OpenAI, DeepSeek, LM Studio, Ollama). If a local LLM is chosen, you can customize the server URL and model name.

---

## 7. Running the Three Subsystems

PrismaAI can be executed in three separate modes depending on your testing workflow:

### Mode 1: Interactive CLI Dashboard
For a clean terminal-based monitoring experience with real-time Geyser slot updates:
```bash
npm run interactive
```
* **Real-time monitor**: Displays active slot streams and alerts you when Jito validator leaders are upcoming.
* **Dynamic execution**: Initiates manual transactions using your chosen AI provider, printing cognitive timing, tipping, and retry/broadcast pathways.

### Mode 2: Transaction Relay REST API
Start the Express API server on port 3000:
```bash
npm run api
```
This launches a REST server that exposes endpoints for integration:
* **Health Check**: `GET http://localhost:3000/api/v1/health`
* **Get Logs**: `GET http://localhost:3000/api/v1/transactions`
* **Submit Transfer**: `POST http://localhost:3000/api/v1/submit-transfer` with JSON payload:
  ```json
  {
    "destination": "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "amountLamports": 5000
  }
  ```

### Mode 3: React Web Application Dashboard
To launch the beautiful frontend client:
```bash
npm run dashboard
```
* Builds and runs the Vite React development server on `http://localhost:5173`.
* Connects to the Express API (running on port `3000`).
* **Features**:
  - Connection indicator pills showing gRPC and Relay status.
  - Active Relayer wallet address display.
  - Form to execute AI-optimized SOL transfers.
  - **Cognitive Pipeline Stepper**: Visualizes each stage of the transaction lifecycle (AI Timing Decision, AI Tipping Optimizer, Jito Bundling, Yellowstone Landing stream) in real time.
  - **Live Transaction History**: Displays landed slots, latency metrics, Jito tips paid, and detailed AI reasons for failures.

---

## 8. Bounty Questions & Answers

### Question 1: What does the delta between processed_at and confirmed_at tell you about network health at the time of submission?
The delta indicates **cluster consensus latency**. `Processed` commitment occurs as soon as the current leader includes the transaction in a block. `Confirmed` commitment requires 66% of the validator stake to vote on that block. A high delta (e.g., > 2000ms) indicates that while blocks are being produced, the validator network is struggling to reach consensus—likely due to network partitions, validator voting lag, or high fork rates.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?
A `finalized` blockhash is **~31 slots (~12 seconds) behind the tip of the chain**. Because Solana transactions are valid for a maximum of 150 slots (~60 seconds), fetching a blockhash that is already 31 slots old leaves you with a dangerously narrow window to sign, transmit, and land the transaction before it expires. For time-sensitive MEV or Jito bundles, you must use the freshest possible blockhash (`processed`) to ensure the validator accepts it.

### Question 3: What happens to your bundle if the Jito leader skips their slot?
If the Jito leader skips their slot, **the bundle is discarded and never executes**. Jito bundles are sent directly to Jito Block Engines, which only package them into blocks produced by Jito-enabled validator nodes. If that leader skips their slot, there is no block space to win, and the Block Engine does not forward the bundle to the next leader. The client must detect the skipped slot via slot streams and resubmit the bundle targeting the next available Jito leader slot.

---

## 9. Software Development Kit (SDK) Guide

Developers can import and build custom solutions directly on top of the Solstack SDK.

### 9.1 SDK Module Exports
The SDK exports the following primary components from [src/sdk.ts](file:///home/rootkit/solstack/src/sdk.ts):
1. **NetworkObserver**: Direct connection client for Yellowstone gRPC Geyser block/slot streaming and Jito validator schedule tracking.
2. **TransactionStack**: Serializes versioned transactions, adds Jito tips, signs payloads, and broadcasts atomic bundles.
3. **AIAgent**: Coordinates model prompts and manages the multi-provider failover chain.
4. **LifecycleTracker**: Manages transaction stage logging and auditing.
5. **getDynamicTip**: Directly polls current regional landed tipping percentile floors from Jito.

### 9.2 Code Example: Sending a Transaction via SDK
Below is an example of importing the SDK and using the unmocked AI agent to submit an optimized Jito bundle transfer:
```typescript
import { NetworkObserver, TransactionStack, AIAgent, getDynamicTip } from "./sdk.js";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

// Load keys
const authKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("./auth-keypair.json", "utf-8"))));
const payerKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("./payer-keypair.json", "utf-8"))));

// 1. Initialize Stack and Agent
const stack = new TransactionStack("https://api.testnet.solana.com", "ny.testnet.block-engine.jito.wtf", authKey, payerKey);
const agent = new AIAgent({ provider: "gemini", apiKey: process.env.GEMINI_API_KEY });

// 2. Query dynamic tip floor and consult the AI Agent
const floorData = await getDynamicTip();
const decision = await agent.decideTip(floorData, "Normal");
console.log(`[AI Decided Tip]: ${decision.lamports} lamports. Reason: ${decision.reasoning}`);

// 3. Assemble and broadcast
const ix = SystemProgram.transfer({
  fromPubkey: payerKey.publicKey,
  toPubkey: new PublicKey("destination_address..."),
  lamports: 100000,
});
const build = await stack.buildBundle([ix], decision.lamports, new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"));
const bundleId = await stack.sendBundle(build.bundle);
console.log(`Jito bundle submitted successfully! Bundle ID: ${bundleId}`);
```
