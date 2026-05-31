import axios from "axios";

export interface TipFloor {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
}

export async function getDynamicTip(percentile: keyof TipFloor = "landed_tips_50th_percentile"): Promise<number> {
  try {
    // Correcting Jito Tip API endpoint
    const response = await axios.get("https://mainnet.block-engine.jito.wtf/api/v1/bundles/tip_floor");
    const data = response.data[0] as TipFloor;
    
    // Fallback to 0.0001 SOL if API fails to provide expected structure
    const tipInSol = (data as any)[percentile] || 0.0001;
    return Math.floor(tipInSol * 1_000_000_000); 
  } catch (error) {
    console.warn("Failed to fetch dynamic tip from Jito API, using fallback 100,000 lamports");
    return 100_000; 
  }
}
