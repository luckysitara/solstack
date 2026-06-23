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
  getModelName(): string;
  decideTip(floorData: any, congestion: string): Promise<TipDecision>;
  decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean): Promise<TimingDecision>;
  reasonAboutFailure(error: string, context: any): Promise<RetryPlan>;
}

/**
 * Utility to safely extract and parse JSON from LLM string output
 */
function parseJSONResponse(text: string): any {
  let cleaned = text.trim();
  
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // Remove block comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove single-line comments
  cleaned = cleaned.replace(/\/\/.*$/gm, "");
  // Remove trailing commas before closing braces or brackets (recursive)
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");

  // Find all balanced brace blocks
  const blocks: string[] = [];
  let braceCount = 0;
  let firstBraceIndex = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      if (braceCount === 0) {
        firstBraceIndex = i;
      }
      braceCount++;
    } else if (cleaned[i] === "}") {
      if (braceCount > 0) {
        braceCount--;
        if (braceCount === 0 && firstBraceIndex !== -1) {
          blocks.push(cleaned.substring(firstBraceIndex, i + 1));
          firstBraceIndex = -1;
        }
      }
    }
  }

  // Try parsing from the last block backwards (to get the final JSON output block)
  for (let i = blocks.length - 1; i >= 0; i--) {
    let block = blocks[i];
    try {
      return JSON.parse(block);
    } catch (e) {
      try {
        const fixed = block.replace(/'/g, '"');
        return JSON.parse(fixed);
      } catch (inner) {}
    }
  }

  // If no blocks parsed, try parsing the whole cleaned string
  try {
    return JSON.parse(cleaned);
  } catch (e: any) {
    try {
      const fixed = cleaned.replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (inner) {
      throw new Error(`Failed to parse JSON response from blocks [${blocks.join(", ")}] or text. Original text: ${text}`);
    }
  }
}

// ==========================================
// 1. Google Gemini Provider
// ==========================================
export class GeminiProvider implements AIProvider {
  private model: any;
  private modelName: string;

  constructor(apiKey: string) {
    this.modelName = "gemini-2.0-flash";
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: this.modelName,
      generationConfig: { responseMimeType: "application/json" }
    });
  }

  getModelName(): string {
    return this.modelName;
  }

  async decideTip(floorData: any, congestion: string): Promise<TipDecision> {
    const prompt = `Analyze current Jito Solana tip floor data: ${JSON.stringify(floorData)} and Solana network congestion level: "${congestion}".
Determine an optimal Jito bundle tip in lamports (typically between 10000 and 20000000). Provide your logical reasoning based on the inputs.
Respond with JSON matching this schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    const res = await this.model.generateContent(prompt);
    return parseJSONResponse(res.response.text());
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean): Promise<TimingDecision> {
    const prompt = `Analyze Solana execution timing. Current Slot: ${currentSlot}, Jito Validator Leader Upcoming within next 4 slots: ${isJitoLeaderUpcoming}.
Determine if we should submit now or wait. If we should wait, specify waitTimeMs (typically 10 to 150ms). Provide logical reasoning.
Respond with JSON matching this schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    const res = await this.model.generateContent(prompt);
    return parseJSONResponse(res.response.text());
  }

  async reasonAboutFailure(error: string, context: any): Promise<RetryPlan> {
    const prompt = `Analyze transaction execution failure. Error message: "${error}", Context: ${JSON.stringify(context)}.
Determine if we should retry, abort, wait, or bypass Jito and broadcast directly to RPC ("direct_broadcast").
CRITICAL recovery instruction: If the error message indicates a timeout, Jito Timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to land the transaction immediately via standard RPC.
Specify a new tip multiplier (e.g. 1.2 to 2.0) and whether to refresh the blockhash. Provide reasoning.
Respond with JSON matching this schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    const res = await this.model.generateContent(prompt);
    return parseJSONResponse(res.response.text());
  }
}

// ==========================================
// 2. Anthropic Claude Provider
// ==========================================
export class AnthropicProvider implements AIProvider {
  private apiKey: string;
  private modelName: string;

  constructor(apiKey: string, modelName = "") {
    this.apiKey = apiKey || process.env.ANTHROPIC_AUTH_TOKEN || "";
    this.modelName = modelName || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
  }

  getModelName(): string {
    return this.modelName;
  }

  private async callClaude(prompt: string): Promise<any> {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (baseUrl.includes("api.anthropic.com")) {
      headers["anthropic-version"] = "2023-06-01";
    }

    const response = await axios.post(
      `${baseUrl}/messages`,
      {
        model: this.modelName,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }]
      },
      { headers }
    );
    const content = response.data.content[0].text;
    return parseJSONResponse(content);
  }

  async decideTip(floorData: any, congestion: string) {
    const prompt = `Analyze Jito tip floor data: ${JSON.stringify(floorData)} and Solana network congestion level: "${congestion}".
Determine optimal Jito tip in lamports and write a brief reasoning.
Output JSON schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    return this.callClaude(prompt);
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Analyze Solana transaction timing. Current Slot: ${currentSlot}, Jito Leader Upcoming: ${isJitoLeaderUpcoming}.
Decide shouldSubmit, waitTimeMs, and write reasoning.
Output JSON schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    return this.callClaude(prompt);
  }

  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Analyze transaction execution failure. Error: "${error}", Context: ${JSON.stringify(context)}.
Decide action ("retry" | "abort" | "wait" | "direct_broadcast"), newTipMultiplier, refreshBlockhash, and write reasoning.
CRITICAL recovery instruction: If the error indicates a timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to bypass Jito and land the transaction immediately via standard RPC.
Output JSON schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    return this.callClaude(prompt);
  }
}

// ==========================================
// 3. DeepSeek Provider
// ==========================================
export class DeepSeekProvider implements AIProvider {
  private apiKey: string;
  private modelName = "deepseek-chat";
  private baseUrl = "https://api.deepseek.com";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getModelName(): string {
    return this.modelName;
  }

  private async callDeepSeek(prompt: string): Promise<any> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.modelName,
        messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    return parseJSONResponse(response.data.choices[0].message.content);
  }

  async decideTip(floorData: any, congestion: string) {
    const prompt = `Analyze Solana Jito tip floor data: ${JSON.stringify(floorData)}, congestion: "${congestion}".
Determine tip in lamports and reasoning.
Output JSON schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    return this.callDeepSeek(prompt);
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Analyze Solana slot ${currentSlot}, Jito Leader upcoming: ${isJitoLeaderUpcoming}.
Decide shouldSubmit, waitTimeMs, and reasoning.
Output JSON schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    return this.callDeepSeek(prompt);
  }

  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Analyze transaction execution failure. Error: "${error}", Context: ${JSON.stringify(context)}.
Decide recovery plan action, newTipMultiplier, refreshBlockhash, and reasoning.
CRITICAL recovery instruction: If the error indicates a timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to bypass Jito and land the transaction immediately via standard RPC.
Output JSON schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    return this.callDeepSeek(prompt);
  }
}

// ==========================================
// 4. LM Studio Provider (Local)
// ==========================================
export class LMStudioProvider implements AIProvider {
  private baseUrl: string;
  private modelName: string;

  constructor(baseUrl = "http://localhost:1234/v1", modelName = "") {
    this.baseUrl = baseUrl;
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName || "LMStudio (Auto-detected Model)";
  }

  private async callLMStudio(prompt: string): Promise<any> {
    let model = this.modelName;
    if (!model) {
      try {
        const modelsRes = await axios.get(`${this.baseUrl}/models`);
        if (modelsRes.data && modelsRes.data.data && modelsRes.data.data.length > 0) {
          model = modelsRes.data.data[0].id;
        }
      } catch (err) {
        model = "glm-4.7-flash-uncensored-heretic-neo-code-imatrix-max";
      }
    }
    // Update local cached model name
    this.modelName = model;

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: model,
          messages: [
            {
              role: "system",
              content: "You are a Solana transaction optimizer. You must analyze the inputs and output ONLY valid JSON matching the requested schema. Do not write markdown tags (unless they surround the JSON), explanations, thoughts, or reasoning outside the JSON fields. Your output must parse as standard JSON."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 2048,
          temperature: 0.2
        },
        { timeout: 8000 }
      );
      const content = response.data.choices?.[0]?.message?.content || "";
      if (!content && response.data.choices?.[0]?.message?.reasoning_content) {
        return parseJSONResponse(response.data.choices[0].message.reasoning_content);
      }
      return parseJSONResponse(content);
    } catch (e: any) {
      if (e.response) {
        console.error("[LM Studio Error Details]:", JSON.stringify(e.response.data));
      }
      throw e;
    }
  }

  async decideTip(floorData: any, congestion: string) {
    const prompt = `Analyze Solana Jito tip floors: ${JSON.stringify(floorData)}, network congestion: "${congestion}".
Decide an optimal tip amount in lamports (typically between 10000 and 15000000). Provide your logical reasoning inside the JSON.
Your output must be ONLY a valid JSON object matching this schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    return this.callLMStudio(prompt);
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Analyze Solana Slot: ${currentSlot}, Jito Leader Upcoming: ${isJitoLeaderUpcoming}.
Decide whether to submit immediately or wait. Specify waitTimeMs (typically 0 to 100ms).
Your output must be ONLY a valid JSON object matching this schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    return this.callLMStudio(prompt);
  }

  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Analyze Solana transaction failure. Error: "${error}", Context: ${JSON.stringify(context)}.
Determine recovery action ("retry" | "abort" | "wait" | "direct_broadcast"), newTipMultiplier (float), and refreshBlockhash (boolean).
CRITICAL recovery instruction: If the error indicates a timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to bypass Jito and land the transaction immediately via standard RPC.
Your output must be ONLY a valid JSON object matching this schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    return this.callLMStudio(prompt);
  }
}

// ==========================================
// 5. Ollama Provider (Local)
// ==========================================
export class OllamaProvider implements AIProvider {
  private baseUrl: string;
  private modelName: string;

  constructor(baseUrl = "http://localhost:11434", modelName = "llama3") {
    this.baseUrl = baseUrl;
    this.modelName = modelName;
  }

  getModelName(): string {
    return `Ollama (${this.modelName})`;
  }

  private async callOllama(prompt: string): Promise<any> {
    const response = await axios.post(`${this.baseUrl}/api/chat`, {
      model: this.modelName,
      messages: [
        {
          role: "system",
          content: "You are a Solana transaction optimizer. You must analyze the inputs and output ONLY valid JSON matching the requested schema. No explanations, thoughts, or formatting blocks outside the JSON."
        },
        { role: "user", content: prompt }
      ],
      format: "json",
      stream: false,
      options: {
        num_predict: 1000,
        temperature: 0.2
      }
    }, { timeout: 8000 });
    return parseJSONResponse(response.data.message.content);
  }

  async decideTip(floorData: any, congestion: string) {
    const prompt = `Analyze Solana Jito tip floors: ${JSON.stringify(floorData)}, network congestion: "${congestion}".
Decide an optimal tip amount in lamports (typically between 10000 and 15000000). Provide your logical reasoning inside the JSON.
Your output must be ONLY a valid JSON object matching this schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    return this.callOllama(prompt);
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Analyze Solana Slot: ${currentSlot}, Jito Leader Upcoming: ${isJitoLeaderUpcoming}.
Decide whether to submit immediately or wait. Specify waitTimeMs (typically 0 to 100ms).
Your output must be ONLY a valid JSON object matching this schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    return this.callOllama(prompt);
  }

  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Analyze Solana transaction failure. Error: "${error}", Context: ${JSON.stringify(context)}.
Determine recovery action ("retry" | "abort" | "wait" | "direct_broadcast"), newTipMultiplier (float), and refreshBlockhash (boolean).
CRITICAL recovery instruction: If the error indicates a timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to bypass Jito and land the transaction immediately via standard RPC.
Your output must be ONLY a valid JSON object matching this schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    return this.callOllama(prompt);
  }
}

// ==========================================
// 6. OpenAI Provider
// ==========================================
export class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private modelName: string;

  constructor(apiKey: string, modelName = "gpt-4o-mini") {
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName;
  }

  private async callOpenAI(prompt: string): Promise<any> {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: this.modelName,
        messages: [{ role: "user", content: prompt + " Respond ONLY with valid JSON." }],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    return parseJSONResponse(response.data.choices[0].message.content);
  }

  async decideTip(floorData: any, congestion: string) {
    const prompt = `Analyze Solana Jito tip floor data: ${JSON.stringify(floorData)}, congestion: "${congestion}".
Determine tip in lamports and reasoning.
Output JSON schema:
{
  "lamports": number,
  "reasoning": "string"
}`;
    return this.callOpenAI(prompt);
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean) {
    const prompt = `Analyze Solana slot ${currentSlot}, Jito Leader upcoming: ${isJitoLeaderUpcoming}.
Decide shouldSubmit, waitTimeMs, and reasoning.
Output JSON schema:
{
  "shouldSubmit": boolean,
  "waitTimeMs": number,
  "reasoning": "string"
}`;
    return this.callOpenAI(prompt);
  }

  async reasonAboutFailure(error: string, context: any) {
    const prompt = `Analyze transaction execution failure. Error: "${error}", Context: ${JSON.stringify(context)}.
Decide action ("retry" | "abort" | "wait" | "direct_broadcast"), newTipMultiplier, refreshBlockhash, and reasoning.
CRITICAL recovery instruction: If the error indicates a timeout, connection failure, or 'Jito sendBundle timeout', recommend "direct_broadcast" to bypass Jito and land the transaction immediately via standard RPC.
Output JSON schema:
{
  "action": "retry" | "abort" | "wait" | "direct_broadcast",
  "newTipMultiplier": number,
  "refreshBlockhash": boolean,
  "reasoning": "string"
}`;
    return this.callOpenAI(prompt);
  }
}

// ==========================================
// AI Agent Factory & Orchestrator
// ==========================================
export interface AgentConfig {
  provider: string; // "gemini" | "anthropic" | "deepseek" | "lmstudio" | "ollama" | "openai"
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

export class AIAgent {
  private activeProvider!: AIProvider;
  private providerChain: AIProvider[] = [];

  constructor(config: AgentConfig) {
    this.buildProviderChain(config);

    if (this.providerChain.length === 0) {
      throw new Error("[AIAgent] No AI Providers could be configured. Please check your credentials and local endpoints.");
    }
    this.activeProvider = this.providerChain[0];
  }

  private buildProviderChain(config: AgentConfig) {
    const primary = (config.provider || "").toLowerCase();
    const candidates: { name: string; provider: AIProvider; isPrimary: boolean }[] = [];

    const addGemini = (key: string | undefined, isPrimary: boolean) => {
      if (key && key.trim() !== "") {
        candidates.push({ name: "gemini", provider: new GeminiProvider(key), isPrimary });
      }
    };

    const addAnthropic = (key: string | undefined, isPrimary: boolean) => {
      if (key && key.trim() !== "") {
        candidates.push({ name: "anthropic", provider: new AnthropicProvider(key, config.modelName), isPrimary });
      }
    };

    const addDeepSeek = (key: string | undefined, isPrimary: boolean) => {
      if (key && key.trim() !== "") {
        candidates.push({ name: "deepseek", provider: new DeepSeekProvider(key), isPrimary });
      }
    };

    const addOpenAI = (key: string | undefined, isPrimary: boolean) => {
      if (key && key.trim() !== "") {
        candidates.push({ name: "openai", provider: new OpenAIProvider(key, config.modelName), isPrimary });
      }
    };

    const addLMStudio = (isPrimary: boolean) => {
      const url = config.baseUrl || process.env.AI_URL || "http://localhost:1234/v1";
      const model = config.modelName || process.env.AI_MODEL || "";
      candidates.push({ name: "lmstudio", provider: new LMStudioProvider(url, model), isPrimary });
    };

    const addOllama = (isPrimary: boolean) => {
      const url = process.env.OLLAMA_URL || "http://localhost:11434";
      const model = config.modelName || process.env.OLLAMA_MODEL || "llama3";
      candidates.push({ name: "ollama", provider: new OllamaProvider(url, model), isPrimary });
    };

    // 1. Add primary first if configured
    if (primary === "gemini") addGemini(config.apiKey || process.env.GEMINI_API_KEY, true);
    else if (primary === "anthropic") addAnthropic(config.apiKey || process.env.ANTHROPIC_API_KEY, true);
    else if (primary === "deepseek") addDeepSeek(config.apiKey || process.env.DEEPSEEK_API_KEY, true);
    else if (primary === "openai") addOpenAI(config.apiKey || process.env.OPENAI_API_KEY, true);
    else if (primary === "lmstudio") addLMStudio(true);
    else if (primary === "ollama") addOllama(true);

    // 2. Add others as fallbacks if they are not the primary
    if (primary !== "gemini") addGemini(process.env.GEMINI_API_KEY, false);
    if (primary !== "anthropic") addAnthropic(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY, false);
    if (primary !== "deepseek") addDeepSeek(process.env.DEEPSEEK_API_KEY, false);
    if (primary !== "openai") addOpenAI(process.env.OPENAI_API_KEY, false);
    if (primary !== "lmstudio") addLMStudio(false);
    if (primary !== "ollama") addOllama(false);

    // 3. Populate providerChain preserving priority
    const sorted = [
      ...candidates.filter(c => c.isPrimary),
      ...candidates.filter(c => !c.isPrimary)
    ];

    this.providerChain = sorted.map(c => c.provider);
    console.log(`[AIAgent] Configured provider chain: ${sorted.map(c => `${c.name} (${c.provider.getModelName()})`).join(", ")}`);
  }

  /**
   * Orchestrates the task across the active provider, failing over to alternative
   * active providers if a rate limit or HTTP error occurs. No hardcoded logic.
   */
  private async execute<T>(task: (p: AIProvider) => Promise<T>): Promise<T> {
    let lastError: any = null;
    
    for (const provider of this.providerChain) {
      try {
        console.log(`[AIAgent] Consulting active provider: ${provider.constructor.name} (Model: ${provider.getModelName()})`);
        return await task(provider);
      } catch (e: any) {
        console.warn(`[AIAgent] Failover: Provider ${provider.constructor.name} failed (${e.message || e}). Trying next...`);
        lastError = e;
      }
    }
    
    // Throw error if all providers in the chain fail. No hardcoded overrides.
    throw new Error(`[AIAgent] Execution failed: All configured AI Providers in the chain failed. Last Error: ${lastError?.message || lastError}`);
  }

  async decideTip(floorData: any, congestion: string): Promise<TipDecision> {
    const res = await this.execute(p => p.decideTip(floorData, congestion));
    return {
      lamports: typeof res.lamports === "number" ? Math.round(res.lamports) : 13000,
      reasoning: res.reasoning || "Optimized tip recommendation based on live congestion analysis"
    };
  }

  async decideTiming(currentSlot: number, isJitoLeaderUpcoming: boolean): Promise<TimingDecision> {
    const res = await this.execute(p => p.decideTiming(currentSlot, isJitoLeaderUpcoming));
    return {
      shouldSubmit: typeof res.shouldSubmit === "boolean" ? res.shouldSubmit : true,
      waitTimeMs: typeof res.waitTimeMs === "number" ? Math.round(res.waitTimeMs) : 0,
      reasoning: res.reasoning || "Optimized timing alignment resolved"
    };
  }

  async reasonAboutFailure(error: string, context: any): Promise<RetryPlan> {
    const res = await this.execute(p => p.reasonAboutFailure(error, context));
    const allowedActions: RetryPlan["action"][] = ["retry", "abort", "wait", "direct_broadcast"];
    return {
      action: allowedActions.includes(res.action) ? res.action : "direct_broadcast",
      reasoning: res.reasoning || "Recovery strategy resolved",
      newTipMultiplier: typeof res.newTipMultiplier === "number" ? res.newTipMultiplier : 1.5,
      refreshBlockhash: typeof res.refreshBlockhash === "boolean" ? res.refreshBlockhash : true
    };
  }
}
