import axios from "axios";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

// Mainnet-beta addresses
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function fetchJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<any> {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await axios.get(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response.data;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

export async function fetchJupiterSwapTransaction(
  quoteResponse: any,
  userPubkey: PublicKey
): Promise<VersionedTransaction> {
  const url = "https://api.jup.ag/swap/v1/swap";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await axios.post(url, {
      quoteResponse,
      userPublicKey: userPubkey.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
    }, { signal: controller.signal });
    clearTimeout(timeoutId);
    const swapTransactionBase64 = response.data.swapTransaction;
    const swapTxBuf = Buffer.from(swapTransactionBase64, "base64");
    return VersionedTransaction.deserialize(swapTxBuf);
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

export async function fetchRealArbitrageTransactions(
  userPubkey: PublicKey,
  startAmountLamports: number = 10000000 // 0.01 SOL default
): Promise<{ tx1: VersionedTransaction; tx2: VersionedTransaction; quote1: any; quote2: any }> {
  // Step 1: SOL -> USDC Quote
  const quote1 = await fetchJupiterQuote(WSOL_MINT, USDC_MINT, startAmountLamports);
  const tx1 = await fetchJupiterSwapTransaction(quote1, userPubkey);

  // Step 2: USDC -> SOL Quote using the exact output amount from Step 1
  const intermediateAmount = quote1.outAmount;
  const quote2 = await fetchJupiterQuote(USDC_MINT, WSOL_MINT, intermediateAmount);
  const tx2 = await fetchJupiterSwapTransaction(quote2, userPubkey);

  return { tx1, tx2, quote1, quote2 };
}
