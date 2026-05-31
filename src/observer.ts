import ClientImport, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "events";

const Client = (ClientImport as any).default || ClientImport;

export class NetworkObserver extends EventEmitter {
  private client: any;
  private stream: any;

  constructor(grpcUrl: string, xToken?: string) {
    super();
    this.client = new Client(grpcUrl, xToken, {});
  }

  async start() {
    const request: SubscribeRequest = {
      slots: {
        all: { filterByCommitment: true },
      },
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accounts: {},
      commitment: CommitmentLevel.PROCESSED,
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
    };

    this.stream = await this.client.subscribe();
    
    this.stream.on("data", (data: any) => {
      if (data.slot) {
        this.emit("slot", data.slot);
      }
      if (data.transaction) {
        this.emit("transaction", data.transaction);
      }
    });

    this.stream.on("error", (error: any) => {
      this.emit("error", error);
    });

    await new Promise<void>((resolve, reject) => {
      this.stream.write(request, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async watchSignature(signature: string) {
    console.log(`Watching for signature: ${signature}`);
  }
}
