#!/usr/bin/env node
require('dotenv').config();
const { Connection } = require('@solana/web3.js');

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

(async () => {
  const txSig = 'rVqeTJPijJBjV813FwiGkmEmRqa9fWxoHtJn2H8Tkt6uhB112rZ6zRq7zxd2wG3oWKxK3V2vpat4PYTZt1WEdV2';

  const tx = await connection.getParsedTransaction(txSig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  });

  if (!tx || !tx.meta) {
    console.log('Transaction not found');
    return;
  }

  console.log('Transaction status:', tx.meta.err ? 'FAILED' : 'SUCCESS');
  console.log('SOL fee:', (tx.meta.fee || 0) / 1e9, 'SOL');

  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];

  console.log('\nUSDC balance changes:');
  let totalUsdcChange = 0;
  for (const post of postBalances) {
    if (post.mint !== USDC_MINT) continue;

    const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
    if (!pre) continue;

    const preAmount = parseInt(pre.uiTokenAmount.amount) / 1e6;
    const postAmount = parseInt(post.uiTokenAmount.amount) / 1e6;
    const change = postAmount - preAmount;
    totalUsdcChange += change;

    console.log(`  Account ${post.accountIndex}: ${preAmount.toFixed(2)} → ${postAmount.toFixed(2)} (change: ${change.toFixed(2)} USDC)`);
  }

  console.log(`\nTotal USDC change: ${totalUsdcChange.toFixed(2)} USDC`);
  console.log('\nExpected:');
  console.log('  Entry: ~$4.89 spent');
  console.log('  Exit: should receive close to $4.89 (minus small loss)');
})();
