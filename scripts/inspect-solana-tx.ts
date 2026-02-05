#!/usr/bin/env npx ts-node
/**
 * CLI tool to inspect Solana transactions
 * Usage: npx ts-node scripts/inspect-solana-tx.ts <signature>
 */

import * as dotenv from 'dotenv';

dotenv.config();

const signature = process.argv[2];

if (!signature) {
  console.error('Usage: npx ts-node scripts/inspect-solana-tx.ts <transaction_signature>');
  console.error('');
  console.error('Example: npx ts-node scripts/inspect-solana-tx.ts 5xyz...');
  process.exit(1);
}

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
}

interface SolanaFMResponse {
  status: string;
  message: string;
  result: {
    blockTime: number;
    slot: number;
    err: unknown;
    fee: number;
    data: Array<{
      action: string;
      status: string;
      source: string;
      sourceProtocol?: { name: string };
      tokenTransfers?: TokenTransfer[];
    }>;
  };
}

async function main() {
  // Use SolanaFM API (free, no key required)
  const url = `https://api.solana.fm/v0/transfers/${signature}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      // Fallback to basic Solscan link
      console.log('Could not fetch transaction details.');
      console.log(`View on Solscan: https://solscan.io/tx/${signature}`);
      process.exit(0);
    }

    const data = await response.json() as SolanaFMResponse;

    if (data.status !== 'Success' || !data.result) {
      console.log('Transaction not found or still processing.');
      console.log(`View on Solscan: https://solscan.io/tx/${signature}`);
      process.exit(0);
    }

    const result = data.result;
    const txTime = new Date(result.blockTime * 1000).toISOString();

    console.log(JSON.stringify({
      signature,
      timestamp: txTime,
      slot: result.slot,
      fee_lamports: result.fee,
      fee_sol: result.fee / 1e9,
      success: result.err === null,
      error: result.err,
      actions: result.data?.map(d => ({
        action: d.action,
        status: d.status,
        source: d.source,
        protocol: d.sourceProtocol?.name,
        token_transfers: d.tokenTransfers?.map(t => ({
          mint: t.mint,
          amount: t.tokenAmount,
          from: t.fromUserAccount,
          to: t.toUserAccount,
        })),
      })),
      solscan_url: `https://solscan.io/tx/${signature}`,
    }, null, 2));

  } catch (error) {
    console.error('Error fetching transaction:', (error as Error).message);
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);
    process.exit(1);
  }
}

main();
