import * as fs from "fs";
import * as path from "path";

export interface LifecycleEntry {
  signature: string;
  slot: number;
  tip: number;
  stages: {
    submitted_at: number;
    processed_at?: number;
    confirmed_at?: number;
    finalized_at?: number;
  };
  latencyDeltas: {
    to_processed?: number;
    to_confirmed?: number;
  };
  status: "success" | "failed";
  error?: string;
  aiReasoning?: string;
}

export class LifecycleTracker {
  private logs: LifecycleEntry[] = [];
  private logPath: string;

  constructor(logDir: string) {
    this.logPath = path.join(logDir, "lifecycle.json");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  recordSubmission(signature: string, slot: number, tip: number): LifecycleEntry {
    const entry: LifecycleEntry = {
      signature,
      slot,
      tip,
      stages: {
        submitted_at: Date.now(),
      },
      latencyDeltas: {},
      status: "success",
    };
    this.logs.push(entry);
    this.save();
    return entry;
  }

  updateStage(signature: string, stage: keyof LifecycleEntry["stages"]) {
    const entry = this.logs.find((l) => l.signature === signature);
    if (entry) {
      const now = Date.now();
      (entry.stages as any)[stage] = now;

      if (stage === "processed_at") {
        entry.latencyDeltas.to_processed = now - entry.stages.submitted_at;
      } else if (stage === "confirmed_at" && entry.stages.processed_at) {
        entry.latencyDeltas.to_confirmed = now - entry.stages.processed_at;
      }
      this.save();
    }
  }

  recordFailure(signature: string, error: string, aiReasoning?: string) {
    const entry = this.logs.find((l) => l.signature === signature);
    if (entry) {
      entry.status = "failed";
      entry.error = error;
      entry.aiReasoning = aiReasoning;
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
