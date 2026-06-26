import ClientImport, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";

const Client = (ClientImport as any).default || ClientImport;

async function main() {
  const host = "https://fra.grpc.solinfra.dev:443";
  const apiKey = "fc60677130b9b4c2799d0358d2aa39f9889e7fc9af0e6902ba17a8e49a89a93d";
  console.log(`Connecting to devnet Yellowstone: ${host}...`);
  
  const client = new Client(host, apiKey, undefined);
  try {
    await client.connect();
    console.log("✅ Connected successfully!");

    console.log("Subscribing to devnet slot stream directly...");
    const stream = await client.subscribe();
    console.log("✅ Subscription stream opened successfully!");

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

    let count = 0;
    stream.on("data", (data: any) => {
      if (data.slot) {
        console.log(`📡 [Devnet] Slot: ${data.slot.slot}, Status: ${data.slot.status}`);
        count++;
      }
    });

    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log("Waiting 5 seconds for live devnet slot data...");
    await new Promise(r => setTimeout(r, 5000));
    stream.destroy();
    
    if (count > 0) {
      console.log(`✅ Success! Received ${count} slot updates on devnet.`);
      process.exit(0);
    } else {
      console.log("⚠️ Stream opened but no slots received.");
      process.exit(1);
    }

  } catch (e: any) {
    console.error("❌ Devnet gRPC test failed:");
    console.dir(e, { depth: null });
    process.exit(1);
  }
}

main();
