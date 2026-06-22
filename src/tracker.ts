import * as fs from "fs";
import * as path from "path";

export type FailureClassification = "ExpiredBlockhash" | "FeeTooLow" | "ComputeExceeded" | "BundleFailure" | "AuctionLost" | "Other";

/**
 * Detailed lifecycle progression of a single Solana transaction bundle.
 */
export interface LifecycleEntry {
  bundle_id: string;
  signature: string;
  solscan_url: string; // Enhancement: Solscan link for verification
  slot: number;
  tip_lamports: number;
  status: "success" | "failed";
  
  commitment_progression: {
    submitted_at: number;
    processed_at?: number;
    confirmed_at?: number;
    finalized_at?: number;
  };

  latency_metrics: {
    to_processed_ms?: number;
    to_confirmed_ms?: number;
    to_finalized_ms?: number;
  };

  failure_details?: {
    classification: FailureClassification;
    error_message: string;
    ai_reasoning: string;
  };
}

export function classifyFailure(errorMessage: string): FailureClassification {
  const err = errorMessage.toLowerCase();
  if (err.includes("blockhash") || err.includes("expired") || err.includes("blockhash not found")) {
    return "ExpiredBlockhash";
  }
  if (err.includes("fee too low") || err.includes("insufficient funds") || err.includes("tx fee") || err.includes("lamports")) {
    return "FeeTooLow";
  }
  if (err.includes("compute budget") || err.includes("exceeded") || err.includes("compute limit")) {
    return "ComputeExceeded";
  }
  if (err.includes("timeout") || err.includes("bundle") || err.includes("auction lost") || err.includes("discarded")) {
    return "BundleFailure";
  }
  return "Other";
}

export class LifecycleTracker {
  private logs: LifecycleEntry[] = [];
  private logPath: string;
  private network: string;

  constructor(logDir: string, network: string = "mainnet-beta") {
    this.logPath = path.join(logDir, "lifecycle.json");
    this.network = network;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    if (fs.existsSync(this.logPath)) {
      try {
        this.logs = JSON.parse(fs.readFileSync(this.logPath, "utf-8"));
      } catch (e) {
        this.logs = [];
      }
    }
  }

  recordSubmission(signature: string, bundleId: string, slot: number, tip: number): LifecycleEntry {
    const solscanNetwork = this.network === "mainnet-beta" ? "" : `?cluster=${this.network}`;
    const entry: LifecycleEntry = {
      bundle_id: bundleId,
      signature,
      solscan_url: `https://solscan.io/tx/${signature}${solscanNetwork}`,
      slot,
      tip_lamports: tip,
      status: "success",
      commitment_progression: {
        submitted_at: Date.now(),
      },
      latency_metrics: {},
    };
    this.logs.push(entry);
    this.save();
    return entry;
  }

  updateStage(signature: string, stage: keyof LifecycleEntry["commitment_progression"]) {
    const entry = this.logs.find((l) => l.signature === signature || l.bundle_id === signature);
    if (entry) {
      const now = Date.now();
      (entry.commitment_progression as any)[stage] = now;

      if (stage === "processed_at") {
        entry.latency_metrics.to_processed_ms = now - entry.commitment_progression.submitted_at;
      } else if (stage === "confirmed_at" && entry.commitment_progression.processed_at) {
        entry.latency_metrics.to_confirmed_ms = now - entry.commitment_progression.processed_at;
      } else if (stage === "finalized_at" && entry.commitment_progression.confirmed_at) {
        entry.latency_metrics.to_finalized_ms = now - entry.commitment_progression.confirmed_at;
      }
      this.save();
    }
  }

  updateStageWithSlot(signature: string, stage: keyof LifecycleEntry["commitment_progression"], actualSlot: number) {
    const entry = this.logs.find((l) => l.signature === signature || l.bundle_id === signature);
    if (entry) {
      entry.slot = actualSlot;
      const now = Date.now();
      (entry.commitment_progression as any)[stage] = now;
      if (stage === "processed_at") {
        entry.latency_metrics.to_processed_ms = now - entry.commitment_progression.submitted_at;
      }
      this.save();
    }
  }

  updateStageBySlot(slot: number, stage: keyof LifecycleEntry["commitment_progression"]) {
    const entries = this.logs.filter((l) => l.slot === slot && l.status === "success");
    const now = Date.now();
    let updated = false;
    for (const entry of entries) {
      if (!(entry.commitment_progression as any)[stage]) {
        (entry.commitment_progression as any)[stage] = now;
        if (stage === "confirmed_at" && entry.commitment_progression.processed_at) {
          entry.latency_metrics.to_confirmed_ms = now - entry.commitment_progression.processed_at;
        } else if (stage === "finalized_at" && entry.commitment_progression.confirmed_at) {
          entry.latency_metrics.to_finalized_ms = now - entry.commitment_progression.confirmed_at;
        }
        updated = true;
      }
    }
    if (updated) {
      this.save();
    }
  }

  recordFailure(signature: string, error: string, classification: FailureClassification, aiReasoning: string) {
    const entry = this.logs.find((l) => l.signature === signature || l.bundle_id === signature);
    if (entry) {
      entry.status = "failed";
      entry.failure_details = {
        classification,
        error_message: error,
        ai_reasoning: aiReasoning,
      };
      this.save();
    }
  }

  private save() {
    fs.writeFileSync(this.logPath, JSON.stringify(this.logs, null, 2));
  }

  getLogs() {
    return this.logs;
  }
}
