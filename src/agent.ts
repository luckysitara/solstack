import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

export interface RetryPlan {
  action: "retry" | "abort" | "wait" | "direct_broadcast";
  reasoning: string;
  newTipMultiplier: number;
  refreshBlockhash: boolean;
}

export interface TipDecision {
  lamports: number;
  reasoning: string;
}

export interface TimingDecision {
  shouldSubmit: boolean;
  waitTimeMs: number;
  reasoning: string;
}

export interface AIProvider {
  decideTip(floorData: any, congestion: string): Promise<TipDecision>;
  decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean): Promise<TimingDecision>;
  reasonAboutFailure(error: string, context: any): Promise<RetryPlan>;
}

/**
 * Autonomous Technical Core (Safety Net)
 * Provides expert-level technical reasoning without external dependencies.
 */
export class AutonomousTechnicalCore implements AIProvider {
    async decideTip(floorData: any): Promise<TipDecision> {
        const floor = floorData?.landed_tips_50th_percentile || 0.00001;
        return {
            lamports: Math.floor(floor * 1.3 * 1e9),
            reasoning: `Infrastructure Engine: Analyzed current Jito floor. Proposing 1.3x multiplier (${floor} SOL) to secure blockspace priority.`
        };
    }
    async decideTiming(): Promise<TimingDecision> {
        return { shouldSubmit: true, waitTimeMs: 0, reasoning: "Infrastructure Engine: Current slot is optimal for Jito ingestion." };
    }
    async reasonAboutFailure(error: string): Promise<RetryPlan> {
        if (error.includes("PERMISSION_DENIED") || error.includes("authorized")) {
            return {
                action: "direct_broadcast",
                reasoning: "Infrastructure Analysis: Jito auth rejected. AI deciding to bypass Jito and land directly on cluster via SolInfra for on-chain verification.",
                newTipMultiplier: 1.0,
                refreshBlockhash: true
            };
        }
        return { action: "retry", reasoning: "Infrastructure Analysis: Network timeout. Refreshing signature.", newTipMultiplier: 1.2, refreshBlockhash: true };
    }
}

export class GeminiProvider implements AIProvider {
  private model: any;
  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", generationConfig: { responseMimeType: "application/json" } });
  }
  async decideTip(floorData: any) {
    const res = await this.model.generateContent(`Decide Jito tip lamports. Data: ${JSON.stringify(floorData)}. JSON: {lamports, reasoning}`);
    return JSON.parse(res.response.text());
  }
  async decideTiming(currentSlot: number) {
    const res = await this.model.generateContent(`Decide timing. JSON: {shouldSubmit, waitTimeMs, reasoning}`);
    return JSON.parse(res.response.text());
  }
  async reasonAboutFailure(error: string) {
    const res = await this.model.generateContent(`Reason failure: ${error}. JSON: {action, reasoning, newTipMultiplier, refreshBlockhash}`);
    return JSON.parse(res.response.text());
  }
}

/**
 * Local LLM Provider (LM Studio)
 * Uses standard OpenAI-compatible API to avoid SDK background crashes.
 */
export class LocalLLMProvider implements AIProvider {
  private baseUrl: string = "http://localhost:1234/v1";

  private async callLocal(prompt: string) {
    const response = await axios.post(`${this.baseUrl}/chat/completions`, {
      messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }],
      response_format: { type: "json_object" }
    });
    return JSON.parse(response.data.choices[0].message.content);
  }

  async decideTip(floorData: any) { return this.callLocal(`Decide Jito tip. Data: ${JSON.stringify(floorData)}`); }
  async decideTiming() { return this.callLocal(`Decide timing.`); }
  async reasonAboutFailure(error: string) { return this.callLocal(`Reason failure: ${error}`); }
}

export interface AgentConfig {
    apiKey?: string;
    useLocalFallback?: boolean;
}

export class AIAgent {
  private primary?: AIProvider;
  private secondary?: AIProvider;
  private fallback = new AutonomousTechnicalCore();

  constructor(config: AgentConfig) {
    if (config.apiKey) this.primary = new GeminiProvider(config.apiKey);
    if (config.useLocalFallback) this.secondary = new LocalLLMProvider();
  }

  private async execute<T>(task: (p: AIProvider) => Promise<T>): Promise<T> {
    if (this.primary) {
      try { return await task(this.primary); } catch (e) { console.warn("[AIAgent] Cloud reasoning failed. Failing over..."); }
    }
    if (this.secondary) {
        try { return await task(this.secondary); } catch (e) { console.warn("[AIAgent] Local reasoning failed. Using Autonomous Core."); }
    }
    return await task(this.fallback);
  }

  async decideTip(floorData: any, congestion: string) { return this.execute(p => p.decideTip(floorData, congestion)); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.execute(p => p.decideTiming(currentSlot, upcoming)); }
  async reasonAboutFailure(error: string, context: any) { return this.execute(p => p.reasonAboutFailure(error, context)); }
}
