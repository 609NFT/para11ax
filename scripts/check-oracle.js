#!/usr/bin/env node
/**
 * Check Flash Trade oracle configuration for a specific token
 */
require('dotenv').config();
const { Connection, Keypair } = require('@solana/web3.js');
const { PerpetualsClient } = require('flash-sdk');

async function main() {
  const targetSymbol = process.argv[2] || 'CRCLr';
  
  console.log(`Checking oracle config for: ${targetSymbol}\n`);
  
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(rpcUrl);
  
  // Create a dummy keypair for read-only operations
  const wallet = Keypair.generate();
  
  const client = new PerpetualsClient(conn, 'mainnet-beta', {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  });
  
  await client.loadAddressLookupTable();
  
  // Find the target token in all pools
  for (const pool of client.pools) {
    for (const token of pool.tokens) {
      if (token.symbol === targetSymbol || token.symbol.includes(targetSymbol.replace('r', ''))) {
        console.log('='.repeat(60));
        console.log(`Pool: ${pool.name}`);
        console.log(`Symbol: ${token.symbol}`);
        console.log(`Mint: ${token.mintKey?.toString()}`);
        console.log(`Is Stable: ${token.isStable}`);
        console.log(`Pyth Ticker: ${token.pythTicker || 'N/A'}`);
        
        // Find matching custody for more oracle info
        const custody = pool.custodies?.find(c => c.symbol === token.symbol);
        if (custody) {
          console.log(`\nCustody Account: ${custody.custodyAccount?.toString()}`);
          console.log(`Oracle Address: ${custody.oracleAddress?.toString()}`);
          console.log(`Int Oracle Account: ${custody.intOracleAccount?.toString()}`);
          console.log(`Ext Oracle Account: ${custody.extOracleAccount?.toString()}`);
        }
        
        // Check if there's a short market for this token
        const shortMarket = pool.markets?.find(m => 
          m.side === 1 && // Side.Short = 1
          pool.tokens[m.targetCustodyId]?.symbol === token.symbol
        );
        if (shortMarket) {
          console.log(`\nShort Market Found:`);
          console.log(`  Market Account: ${shortMarket.marketAccount?.toString()}`);
          console.log(`  Target Custody ID: ${shortMarket.targetCustodyId}`);
          console.log(`  Collateral Custody ID: ${shortMarket.collateralCustodyId}`);
        } else {
          console.log(`\nNo short market available for ${token.symbol}`);
        }
        console.log('');
      }
    }
  }
}

main().catch(console.error);
