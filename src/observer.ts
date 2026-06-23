import ClientImport, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "events";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import bs58 from "bs58";

const Client = (ClientImport as any).default || ClientImport;

export enum SlotStatus {
  SLOT_PROCESSED = 0,
  SLOT_CONFIRMED = 1,
  SLOT_FINALIZED = 2,
  SLOT_FIRST_SHRED_RECEIVED = 3,
  SLOT_COMPLETED = 4,
  SLOT_CREATED_BANK = 5,
  SLOT_DEAD = 6,
}

export class NetworkObserver extends EventEmitter {
  private client: any;
  private stream: any;
  private connection: Connection;
  private searcherClientInstance: any;
  private isConnecting = false;
  private retryCount = 0;
  private maxRetries = 10;
  public isStopped = false;

  constructor(
    grpcUrl: string,
    apiKey: string,
    rpcUrl: string,
    blockEngineUrl?: string,
    authKeypair?: Keypair
  ) {
    super();
    this.client = new Client(grpcUrl, apiKey || undefined, undefined);
    this.connection = new Connection(rpcUrl, "processed");
    if (blockEngineUrl && authKeypair) {
      this.searcherClientInstance = searcherClient(blockEngineUrl, authKeypair);
    }
  }

  async start() {
    this.isStopped = false;
    await this.connectWithRetry();
  }

  async stop() {
    this.isStopped = true;
    if (this.stream) {
      try {
        this.stream.destroy();
      } catch (e) {}
      this.stream = null;
    }
  }

  private async connectWithRetry() {
    if (this.isConnecting || this.isStopped) return;
    this.isConnecting = true;

    const request: SubscribeRequest = {
      slots: { all: { filterByCommitment: true } },
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accounts: {},
      commitment: CommitmentLevel.PROCESSED,
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
    };

    while (this.retryCount < this.maxRetries && !this.isStopped) {
      try {
        console.log(`[Observer] Connecting to Yellowstone gRPC (Attempt ${this.retryCount + 1}/${this.maxRetries})...`);
        await this.client.connect();
        
        if (this.isStopped) {
          try { this.client.disconnect(); } catch (e) {}
          break;
        }

        this.stream = await this.client.subscribe();

        this.stream.on("data", (data: any) => {
          if (this.isStopped) return;
          if (data.slot) {
            const slotUpdate = data.slot;
            const slotNum = parseInt(slotUpdate.slot, 10);
            setImmediate(() => {
              this.emit("slot", {
                slot: slotNum,
                status: slotUpdate.status,
                parent: slotUpdate.parent ? parseInt(slotUpdate.parent, 10) : undefined,
              });
            });
          }
          if (data.transaction) {
            const txUpdate = data.transaction;
            if (txUpdate.transaction && txUpdate.transaction.signature) {
              const sigBase58 = bs58.encode(txUpdate.transaction.signature);
              const slotNum = parseInt(txUpdate.slot, 10);
              setImmediate(() => {
                this.emit("transaction", {
                  signature: sigBase58,
                  slot: slotNum,
                  err: txUpdate.meta?.err || null,
                });
              });
            }
          }
        });

        this.stream.on("error", (error: any) => {
          if (this.isStopped) return;
          console.error("[Observer] Stream error:", error);
          this.handleDisconnect();
        });

        this.stream.on("end", () => {
          if (this.isStopped) return;
          console.warn("[Observer] Stream ended by server.");
          this.handleDisconnect();
        });

        this.stream.on("close", () => {
          if (this.isStopped) return;
          console.warn("[Observer] Stream closed.");
          this.handleDisconnect();
        });

        await new Promise<void>((resolve, reject) => {
          if (this.isStopped) return reject(new Error("Observer stopped during subscription handshake"));
          this.stream.write(request, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        console.log("[Observer] Yellowstone gRPC connected and subscribed successfully.");
        this.retryCount = 0;
        this.isConnecting = false;
        return;
      } catch (e: any) {
        console.error(`[Observer] Connection failed: ${e.message || e}`);
        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
        console.log(`[Observer] Retrying in ${delay}ms...`);
        
        if (this.isStopped) break;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.isConnecting = false;
    if (!this.isStopped) {
      console.error("[Observer] Max reconnection retries reached. Stream offline.");
    }
  }

  private handleDisconnect() {
    if (this.isStopped) return;
    if (this.stream) {
      try {
        this.stream.destroy();
      } catch (e) {}
      this.stream = null;
    }
    setTimeout(() => {
      if (!this.isStopped) this.connectWithRetry();
    }, 2000);
  }

  async isJitoLeaderUpcoming(windowSlots: number = 4): Promise<boolean> {
    if (!this.searcherClientInstance || this.isStopped) {
      return true; // Fallback to true if not configured or stopped
    }
    try {
      const getLeaderPromise = this.searcherClientInstance.getNextScheduledLeader();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Jito schedule timeout")), 2000));
      const nextLeaderResult = await Promise.race([getLeaderPromise, timeoutPromise]) as any;

      if (nextLeaderResult.ok) {
        const val = nextLeaderResult.value;
        const diff = val.nextLeaderSlot - val.currentSlot;
        console.log(
          `[Jito Schedule] Current Slot: ${val.currentSlot}, Next Jito Slot: ${val.nextLeaderSlot} (Diff: ${diff} slots), Validator: ${val.nextLeaderIdentity}`
        );
        return diff >= 0 && diff <= windowSlots;
      }
      return true; // Fallback on failed ok result
    } catch (e) {
      console.log(`[Jito Schedule] Offline/Timeout (Using default fallback timing)`);
      return true; // Default fallback
    }
  }
}
