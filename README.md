# Smart Transaction Stack - Jito & Yellowstone gRPC

A production-grade Solana transaction infrastructure stack powered by Jito bundles, Yellowstone gRPC streaming, and AI-assisted autonomous decision making.

## Setup Instructions

1.  **Clone the repository:**
    ```bash
    git clone <repo-url>
    cd earn
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Configure Environment:**
    Copy `.env.example` to `.env` and fill in your **SolInfra API Key**, Jito details, and AI keys.
    ```bash
    cp .env.example .env
    ```
4.  **Infrastructure Power:**
    This stack is powered by **SolInfra** for high-performance RPC and Yellowstone gRPC streaming. Ensure your `SOLINFRA_API_KEY` is active.
5.  **AI Provider Setup (LM Studio):**
    The system supports **headless** local AI via LM Studio.
    *   Install LM Studio CLI: `npm install -g @lmstudio/sdk` (provides `lms`).
    *   Download a model: `lms get llama-3.2-3b-instruct`.
    *   Ensure LM Studio is running (Local Server enabled).
    *   The agent will **automatically load** the model from your local library if it's not already running.
6.  **Run the Stack:**
    ```bash
    npx ts-node src/index.ts
    ```

## Bounty Questions

### Question 1: What does the delta between processed_at and confirmed_at tell you about network health at the time of submission?
The delta between `processed` and `confirmed` indicates **cluster consensus latency**. `Processed` happens as soon as a leader includes the transaction in a block. `Confirmed` requires 66% of the stake to vote on that block. A high delta suggests that while blocks are being produced, the network is struggling to reach consensus—likely due to high fork rates, network partitions, or massive validator vote lag.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?
Using `finalized` for a blockhash is dangerous because it is **~31 slots (~12 seconds) behind the tip of the chain**. By the time you fetch a "finalized" blockhash, sign, and submit, the blockhash is already dangerously close to expiring (150 slots). For time-sensitive transactions (like MEV or Jito bundles), you need the freshest possible blockhash (`processed`) to ensure the leader recognizes it as valid.

### Question 3: What happens to your bundle if the Jito leader skips their slot?
If the Jito leader skips their slot, the bundle **simply never executes and effectively "expires"**. Since Jito bundles are sent specifically to the Jito Block Engine to be included in a specific Jito-Solana leader's block, a skipped slot means there is no auction for that window. Your bundle is not "forwarded" to the next leader by the block engine; you must detect the skip via slot streams and resubmit the bundle for the next available Jito leader window.

## Architecture
See [architecture.md](./architecture.md) for a detailed breakdown of the system design.
