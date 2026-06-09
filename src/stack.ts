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

export class TransactionStack {
  private searcher: any = null;
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

  private async getSearcher() {
    if (!this.searcher) {
        console.log(`[Jito] Connecting to real Block Engine: ${this.blockEngineUrl}`);
        this.searcher = searcherClient(this.blockEngineUrl, this.authKeypair);
    }
    return this.searcher;
  }

  async buildBundle(
    instructions: any[],
    tipAmountLamports: number,
    tipAccount: PublicKey
  ): Promise<{ bundle: Bundle; signature: string }> {
    const { blockhash } = await this.connection.getLatestBlockhash("processed");
    const bundleInstructions = [...instructions];
    bundleInstructions.push(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmountLamports,
      })
    );
    const messageV0 = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: bundleInstructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.payer]);
    
    // We use the base58 signature for Solscan
    const signature = tx.signatures[0];
    const signatureString = (await import('bs58')).default.encode(signature);
    
    const bundle = new Bundle([tx], 5);
    return { bundle, signature: signatureString };
  }

  async sendBundle(bundle: Bundle): Promise<string> {
    const s = await this.getSearcher();
    // This is a REAL network call. It will throw an error if Jito rejects it.
    return await s.sendBundle(bundle);
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    const s = await this.getSearcher();
    const accounts = await s.getTipAccounts();
    return accounts.map((a: string) => new PublicKey(a));
  }
}
