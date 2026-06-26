import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

export interface TokenCreationResult {
  instructions: TransactionInstruction[];
  signers: Keypair[];
  mintPubkey: PublicKey;
  ataPubkey: PublicKey;
}

export async function buildTokenCreationInstructions(
  connection: Connection,
  payerPubkey: PublicKey,
  decimals: number = 9,
  mintAmount: number = 1000000
): Promise<TokenCreationResult> {
  const mintKeypair = Keypair.generate();
  const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const instructions: TransactionInstruction[] = [];

  // 1. Create Mint Account instruction
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payerPubkey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports: rentExemptBalance,
      programId: TOKEN_PROGRAM_ID,
    })
  );

  // 2. Initialize Mint instruction
  instructions.push(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      payerPubkey, // mint authority
      payerPubkey  // freeze authority (optional, set to payer)
    )
  );

  // 3. Associated Token Account (ATA) derivation
  const ataAddress = getAssociatedTokenAddressSync(
    mintKeypair.publicKey,
    payerPubkey
  );

  // 4. Create ATA instruction
  instructions.push(
    createAssociatedTokenAccountInstruction(
      payerPubkey,
      ataAddress,
      payerPubkey,
      mintKeypair.publicKey
    )
  );

  // 5. Mint To ATA instruction
  const rawAmount = BigInt(mintAmount) * BigInt(10 ** decimals);
  instructions.push(
    createMintToInstruction(
      mintKeypair.publicKey,
      ataAddress,
      payerPubkey,
      rawAmount
    )
  );

  return {
    instructions,
    signers: [mintKeypair],
    mintPubkey: mintKeypair.publicKey,
    ataPubkey: ataAddress,
  };
}
