import axios from "axios";

export interface TipFloor {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
}

/**
 * Fetches the current Jito tip floor from the REST API.
 * Uses the low-latency bundles explorer API.
 */
export async function getDynamicTip(percentile: keyof TipFloor = "landed_tips_50th_percentile"): Promise<number> {
  try {
    // Official Jito Tip Floor REST API
    const response = await axios.get("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
    
    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      throw new Error("Invalid response format from Jito API");
    }

    const data = response.data[0] as TipFloor;
    const tipInSol = (data as any)[percentile];

    if (tipInSol === undefined) {
      throw new Error(`Percentile ${percentile} not found in Jito data`);
    }

    // Convert SOL (decimal) to Lamports (integer)
    const lamports = Math.floor(tipInSol * 1_000_000_000);
    
    // Safety check: Ensure tip isn't suspiciously low (e.g., 0)
    return Math.max(lamports, 10_000); 

  } catch (error: any) {
    console.warn(`[Jito Tip] Dynamic fetch failed (${error.message}). Using fallback 100,000 lamports.`);
    return 100_000; // 0.0001 SOL fallback
  }
}
