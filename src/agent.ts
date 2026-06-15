import { GoogleGenerativeAI } from "@google/generative-ai";
import { LMStudioClient } from "@lmstudio/sdk";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

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

export class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  constructor(apiKey: string, model: string = "claude-3-5-sonnet-20240620") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }
  private async call(prompt: string): Promise<any> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }],
    });
    return JSON.parse((response.content[0] as any).text.replace(/```json|```/g, "").trim());
  }
  async decideTip(floorData: any, congestion: string) { return this.call(`Jito tip. Data: ${JSON.stringify(floorData)}`); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.call(`Timing. Slot: ${currentSlot}`); }
  async reasonAboutFailure(error: string, context: any) { return this.call(`Failure: ${error}`); }
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }
  private async call(prompt: string): Promise<any> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }],
      response_format: { type: "json_object" }
    });
    return JSON.parse(response.choices[0].message.content!);
  }
  async decideTip(floorData: any, congestion: string) { return this.call(`Jito tip. Data: ${JSON.stringify(floorData)}`); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.call(`Timing. Slot: ${currentSlot}`); }
  async reasonAboutFailure(error: string, context: any) { return this.call(`Failure: ${error}`); }
}

export class GeminiProvider implements AIProvider {
  private model: any;
  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", generationConfig: { responseMimeType: "application/json" } });
  }
  private async call(prompt: string) {
    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }
  async decideTip(floorData: any, congestion: string) { return this.call(`Decide tip lamports. Data: ${JSON.stringify(floorData)}. JSON: {lamports, reasoning}`); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.call(`Decide timing. Slot: ${currentSlot}. JSON: {shouldSubmit, waitTimeMs, reasoning}`); }
  async reasonAboutFailure(error: string, context: any) { return this.call(`Reason failure: ${error}. JSON: {action, reasoning, newTipMultiplier, refreshBlockhash}`); }
}

export class LMStudioProvider implements AIProvider {
  private modelId: string;
  constructor(modelId: string = "any") { this.modelId = modelId; }
  private async getModel() {
    const client = new LMStudioClient();
    const loaded = await client.llm.listLoaded();
    const target = this.modelId === "any" ? loaded[0] : loaded.find(m => m.identifier.includes(this.modelId)) || loaded[0];
    return await client.llm.model(target.identifier);
  }
  async decideTip(floorData: any, congestion: string) {
    const model = await this.getModel();
    const result = await model.respond(`Decide Jito tip. Return JSON: {lamports, reasoning}`);
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

export interface AgentConfig {
    provider?: string;
    apiKey?: string;
    model?: string;
    useLocalFallback?: boolean;
    localModel?: string;
}

export class AIAgent {
  private primary: AIProvider;
  private secondary?: AIProvider;

  constructor(config: AgentConfig) {
    switch (config.provider) {
      case "anthropic": this.primary = new ClaudeProvider(config.apiKey!, config.model!); break;
      case "openai": this.primary = new OpenAICompatibleProvider(config.apiKey!, config.model || "gpt-4o"); break;
      case "deepseek": this.primary = new OpenAICompatibleProvider(config.apiKey!, config.model || "deepseek-chat", "https://api.deepseek.com"); break;
      case "grok": this.primary = new OpenAICompatibleProvider(config.apiKey!, config.model || "grok-beta", "https://api.x.ai/v1"); break;
      case "gemini":
      default: this.primary = new GeminiProvider(config.apiKey!); break;
    }
    if (config.useLocalFallback) this.secondary = new LMStudioProvider(config.localModel);
  }

  private async executeWithFailover<T>(task: (p: AIProvider) => Promise<T>): Promise<T> {
    try {
      return await task(this.primary);
    } catch (e: any) {
      if (this.secondary) {
        console.warn(`[AIAgent] Cloud failed. Failing over to LM Studio...`);
        return await task(this.secondary);
      }
      throw e;
    }
  }
  async decideTip(floorData: any, congestion: string) { return this.executeWithFailover(p => p.decideTip(floorData, congestion)); }
  async decideTiming(currentSlot: number, upcoming: boolean) { return this.executeWithFailover(p => p.decideTiming(currentSlot, upcoming)); }
  async reasonAboutFailure(error: string, context: any) { return this.executeWithFailover(p => p.reasonAboutFailure(error, context)); }
}
