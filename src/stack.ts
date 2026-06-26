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

export function createConnectionWithTimeout(rpcUrl: string, commitment: string = "confirmed"): Connection {
  return new Connection(rpcUrl, {
    commitment: commitment as any,
    fetch: (url, options) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      return fetch(url, { ...options, signal: controller.signal })
        .then(res => {
          clearTimeout(timeoutId);
          return res;
        })
        .catch(err => {
          clearTimeout(timeoutId);
          throw err;
        });
    }
  });
}

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
    this.connection = createConnectionWithTimeout(rpcUrl, "confirmed");
    this.payer = payer;
    this.authKeypair = authKeypair;
    this.blockEngineUrl = blockEngineUrl;
  }
// ... [buildBundle methods remain unchanged] ...
  async buildBundle(
    instructions: any[],
    tipAmountLamports: number,
    tipAccount: PublicKey,
    additionalSigners: Keypair[] = []
  ): Promise<{ bundle: Bundle; signature: string; tx: VersionedTransaction }> {
    const { blockhash } = await this.connection.getLatestBlockhash("processed");
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
    tx.sign([this.payer, ...additionalSigners]);
    const signature = bs58.encode(tx.signatures[0]);
    const bundle = new Bundle([tx], 5);
    return { bundle, signature, tx };
  }

  async buildBundleFromTransactions(
    transactions: VersionedTransaction[],
    tipAmountLamports: number,
    tipAccount: PublicKey
  ): Promise<{ bundle: Bundle; signature: string }> {
    const bundleTxs = [...transactions];
    if (tipAmountLamports > 0) {
      const { blockhash } = await this.connection.getLatestBlockhash("processed");
      const tipIx = SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmountLamports,
      });
      const messageV0 = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [tipIx],
      }).compileToV0Message();
      const tipTx = new VersionedTransaction(messageV0);
      tipTx.sign([this.payer]);
      bundleTxs.push(tipTx);
    }
    const bundle = new Bundle(bundleTxs, 5);
    // Use signature of first transaction as reference
    const signature = bs58.encode(transactions[0].signatures[0]);
    return { bundle, signature };
  }

  async sendBundle(bundle: Bundle): Promise<string> {
    try {
        const useJitoAuth = process.env.USE_JITO_AUTH === "true";
        const s = searcherClient(this.blockEngineUrl, useJitoAuth ? this.authKeypair : undefined);
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
      const isTestnetOrDevnet = this.blockEngineUrl.includes("testnet") || this.blockEngineUrl.includes("devnet");
      const s = searcherClient(this.blockEngineUrl, isTestnetOrDevnet ? undefined : this.authKeypair);
      
      const getTipPromise = s.getTipAccounts();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Jito getTipAccounts timeout")), 3000));
      const res = await Promise.race([getTipPromise, timeoutPromise]) as any;
      
      if (res.ok && res.value && res.value.length > 0) {
        return res.value.map((a: string) => new PublicKey(a));
      }
    } catch (e) {
      console.warn("[Stack] Failed to fetch dynamic Jito tip accounts, using network fallback.");
    }

    if (this.blockEngineUrl.includes("testnet") || this.blockEngineUrl.includes("devnet")) {
      return [
        new PublicKey("F7ThiQUBYiEcyaxpmMuUeACdoiSLKg4SZZ8JSfpFNwAf"),
        new PublicKey("AzfhMPcx3qjbvCK3UUy868qmc5L451W341cpFqdL3EBe"),
        new PublicKey("4uRnem4BfVpZBv7kShVxUYtcipscgZMSHi3B9CSL6gAA"),
        new PublicKey("CwWZzvRgmxj9WLLhdoWUVrHZ1J8db3w2iptKuAitHqoC"),
        new PublicKey("84DrGKhycCUGfLzw8hXsUYX9SnWdh2wW3ozsTPrC5xyg"),
        new PublicKey("BkMx5bRzQeP6tUZgzEs3xeDWJfQiLYvNDqSgmGZKYJDq"),
        new PublicKey("7aewvu8fMf1DK4fKoMXKfs3h3wpAQ7r7D8T1C71LmMF"),
        new PublicKey("G2d63CEgKBdgtpYT2BuheYQ9HFuFCenuHLNyKVpqAuSD")
      ];
    }
    return [
      new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
      new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
      new PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
      new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
      new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
      new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
      new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
      new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT")
    ];
  }
}
