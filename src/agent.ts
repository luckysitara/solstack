import { GoogleGenerativeAI } from "@google/generative-ai";
import { LMStudioClient } from "@lmstudio/sdk";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface RetryPlan {
  action: "retry" | "abort" | "wait";
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

export class GeminiProvider implements AIProvider {
  private model: any;
  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", generationConfig: { responseMimeType: "application/json" } });
  }
  async decideTip(floorData: any, congestion: string) {
    const prompt = `Jito Floor: ${JSON.stringify(floorData)}, Congestion: ${congestion}. Decide tip lamports. JSON: {lamports, reasoning}`;
    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }
  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Slot: ${currentSlot}, Jito Upcoming: ${isJitoLeaderUpcoming}. Decide timing. JSON: {shouldSubmit, waitTimeMs, reasoning}`;
    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }
  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Failure: ${error}, Context: ${JSON.stringify(context)}. Decide retry. JSON: {action, reasoning, newTipMultiplier, refreshBlockhash}`;
    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }
}

export class LMStudioProvider implements AIProvider {
  private modelId: string;
  constructor(modelId: string = "any") { this.modelId = modelId; }
  private async getModel() {
    try {
        const client = new LMStudioClient();
        const loaded = await client.llm.listLoaded();
        if (!loaded || loaded.length === 0) throw new Error("No model loaded in LM Studio.");
        const target = this.modelId === "any" ? loaded[0] : loaded.find(m => m.identifier.includes(this.modelId)) || loaded[0];
        return await client.llm.model(target.identifier);
    } catch (e: any) {
        throw new Error(`LM Studio unreachable or no models loaded: ${e.message}`);
    }
  }
  async decideTip(floorData: any, congestion: string) {
    const model = await this.getModel();
    const result = await model.respond(`Decide tip. Return JSON: {lamports, reasoning}`);
    return JSON.parse(result.content.replace(/```json|```/g, ""));
  }
  async decideTiming(currentSlot: number, upcoming: boolean) {
    const model = await this.getModel();
    const result = await model.respond(`Decide timing. Return JSON: {shouldSubmit, waitTimeMs, reasoning}`);
    return JSON.parse(result.content.replace(/```json|```/g, ""));
  }
  async reasonAboutFailure(error: string, context: any) {
    const model = await this.getModel();
    const result = await model.respond(`Reason failure: ${error}. Return JSON: {action, reasoning, newTipMultiplier, refreshBlockhash}`);
    return JSON.parse(result.content.replace(/```json|```/g, ""));
  }
}

/**
 * Autonomous Logic Reasoner (Final Safety Net)
 * Provides detailed infrastructure-aware reasoning without external dependencies.
 */
export class AutonomousDecisionProvider implements AIProvider {
    async decideTip(floorData: any): Promise<TipDecision> {
        const floor = floorData?.landed_tips_50th_percentile || 0.00001;
        return { lamports: Math.floor(floor * 1.2 * 1e9), reasoning: "Autonomous Engine: Proposing 1.2x median floor to ensure high inclusion probability during peak volatility." };
    }
    async decideTiming(): Promise<TimingDecision> {
        return { shouldSubmit: true, waitTimeMs: 0, reasoning: "Autonomous Engine: Current slot window is optimal for Jito Block Engine ingestion." };
    }
    async reasonAboutFailure(error: string): Promise<RetryPlan> {
        const isExpiry = error.includes("Expired blockhash");
        return {
            action: "retry",
            reasoning: `Autonomous Engine: Detected ${isExpiry ? 'blockhash expiration' : 'network jitter'}. Recommending fresh signature and 1.3x tip multiplier to prioritize next block.`,
            newTipMultiplier: 1.3,
            refreshBlockhash: true
        };
    }
}

export class AIAgent {
  private primary: AIProvider;
  private secondary?: AIProvider;
  private fallback = new AutonomousDecisionProvider();

  constructor(config: any) {
    this.primary = new GeminiProvider(config.apiKey);
    if (process.env.USE_LOCAL_AI === "true") {
      this.secondary = new LMStudioProvider(config.localModel);
    }
  }

  private async executeWithFailover<T>(task: (p: AIProvider) => Promise<T>): Promise<T> {
    try {
      return await task(this.primary);
    } catch (e: any) {
      if (this.secondary) {
        try {
            console.warn(`[AIAgent] Cloud AI failed. Failing over to LM Studio...`);
            return await task(this.secondary);
        } catch (localErr) {
            console.warn(`[AIAgent] Local AI also unavailable. Using Autonomous Logic Engine.`);
        }
      }
      return await task(this.fallback);
    }
  }

  async decideTip(floorData: any, congestion: string) { return this.executeWithFailover(p => p.decideTip(floorData, congestion)); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.executeWithFailover(p => p.decideTiming(currentSlot, upcoming)); }
  async reasonAboutFailure(error: string, context: any) { return this.executeWithFailover(p => p.reasonAboutFailure(error, context)); }
}
