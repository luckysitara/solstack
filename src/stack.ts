import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import bs58 from "bs58";

export class TransactionStack {
  private connection: Connection;
  private payer: Keypair;
  private authKeypair: Keypair;
  private blockEngineUrl: string;

  constructor(
    rpcUrl: string,
    blockEngineUrl: string,
    authKeypair: Keypair,
    payer: Keypair
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.payer = payer;
    this.authKeypair = authKeypair;
    this.blockEngineUrl = blockEngineUrl;
  }

  async buildBundle(
    instructions: any[],
    tipAmountLamports: number,
    tipAccount: PublicKey,
    recentBlockhash?: string
  ): Promise<{ bundle: Bundle; signature: string; tx: VersionedTransaction }> {
    const blockhash = recentBlockhash || (await this.connection.getLatestBlockhash("processed")).blockhash;
    const bundleInstructions = [...instructions];
    if (tipAmountLamports > 0) {
      bundleInstructions.push(
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey: tipAccount,
          lamports: tipAmountLamports,
        })
      );
    }
    const messageV0 = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: bundleInstructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.payer]);
    const signature = bs58.encode(tx.signatures[0]);
    const bundle = new Bundle([tx], 5);
    return { bundle, signature, tx };
  }

  async sendBundle(bundle: Bundle): Promise<string> {
    try {
        const s = searcherClient(this.blockEngineUrl, this.authKeypair);
        const sendPromise = s.sendBundle(bundle);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Jito sendBundle timeout")), 3000));
        const result: any = await Promise.race([sendPromise, timeoutPromise]) as any;
        if (result.ok) return result.value;
        throw new Error(result.error || "Jito Reject");
    } catch (e: any) {
        throw e;
    }
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    try {
      const s = searcherClient(this.blockEngineUrl, this.authKeypair);
      const getTipPromise = s.getTipAccounts();
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Jito getTipAccounts timeout")), 3000));
      const res: any = await Promise.race([getTipPromise, timeoutPromise]) as any;
      if (res.ok && res.value && res.value.length > 0) {
        return res.value.map((a: string) => new PublicKey(a));
      }
    } catch (e: any) {
      console.warn(`[TransactionStack] Failed to fetch Jito tip accounts dynamically (${e.message || e}), using network fallback.`);
    }
    // Network-based fallback
    if (this.blockEngineUrl.includes("testnet") || this.blockEngineUrl.includes("devnet")) {
      return [new PublicKey("3AVipGwXnHY5Z2m48A2qS2dD3B6x4jYNhR467W5q86y5")];
    }
    return [new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY")];
  }
}
