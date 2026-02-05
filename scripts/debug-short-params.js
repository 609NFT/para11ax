#!/usr/bin/env node
/**
 * Debug Flash Trade short params without sending tx
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.ENABLE_SHORTING = 'true';

async function main() {
  const { PerpetualsClient, PoolConfig, Side, OraclePrice, CustodyAccount, Privilege, BN_ZERO, uiDecimalsToNative } = require('flash-sdk');
  const { BN } = require('@coral-xyz/anchor');
  const { PriceServiceConnection } = require('@pythnetwork/price-service-client');

  const pc = PoolConfig.fromIdsByName('Remora.1', 'mainnet-beta');
  const pythConnection = new PriceServiceConnection('https://hermes.pyth.network');
  
  const symbol = 'SPYr';
  const collateralUsd = 5;
  const leverage = 2.0;
  const slippageBps = 150;

  // Get tokens & custodies
  const targetToken = pc.tokens.find(t => t.symbol === symbol);
  const collateralToken = pc.tokens.find(t => t.symbol === 'USDC');
  const targetCustodyConfig = pc.custodies.find(c => c.symbol === symbol);
  const collateralCustodyConfig = pc.custodies.find(c => c.symbol === 'USDC');

  console.log('=== Token Configs ===');
  console.log('Target decimals:', targetToken.decimals);
  console.log('Collateral decimals:', collateralToken.decimals);

  // Fetch Pyth prices
  const targetPythId = targetToken.pythPriceId.startsWith('0x') ? targetToken.pythPriceId.slice(2) : targetToken.pythPriceId;
  const collateralPythId = collateralToken.pythPriceId.startsWith('0x') ? collateralToken.pythPriceId.slice(2) : collateralToken.pythPriceId;
  
  const priceFeeds = await pythConnection.getLatestPriceFeeds([targetPythId, collateralPythId]);
  
  const targetFeed = priceFeeds[0];
  const collateralFeed = priceFeeds[1];
  
  const targetPriceData = targetFeed.getPriceUnchecked();
  const targetEmaPriceData = targetFeed.getEmaPriceUnchecked();
  const collateralPriceData = collateralFeed.getPriceUnchecked();
  const collateralEmaPriceData = collateralFeed.getEmaPriceUnchecked();

  console.log('\n=== Pyth Prices ===');
  console.log('Target price:', targetPriceData.price, 'expo:', targetPriceData.expo);
  console.log('Target EMA:', targetEmaPriceData.price, 'expo:', targetEmaPriceData.expo);
  console.log('Collateral price:', collateralPriceData.price, 'expo:', collateralPriceData.expo);
  console.log('Collateral EMA:', collateralEmaPriceData.price, 'expo:', collateralEmaPriceData.expo);

  // Build OraclePrice objects
  const targetPrice = new OraclePrice({
    price: new BN(targetPriceData.price),
    exponent: new BN(targetPriceData.expo),
    confidence: new BN(targetPriceData.conf),
    timestamp: new BN(targetPriceData.publishTime),
  });
  const targetEmaPrice = new OraclePrice({
    price: new BN(targetEmaPriceData.price),
    exponent: new BN(targetEmaPriceData.expo),
    confidence: new BN(targetEmaPriceData.conf),
    timestamp: new BN(targetEmaPriceData.publishTime),
  });
  const collateralPrice = new OraclePrice({
    price: new BN(collateralPriceData.price),
    exponent: new BN(collateralPriceData.expo),
    confidence: new BN(collateralPriceData.conf),
    timestamp: new BN(collateralPriceData.publishTime),
  });
  const collateralEmaPrice = new OraclePrice({
    price: new BN(collateralEmaPriceData.price),
    exponent: new BN(collateralEmaPriceData.expo),
    confidence: new BN(collateralEmaPriceData.conf),
    timestamp: new BN(collateralEmaPriceData.publishTime),
  });

  // Fetch custody accounts from chain
  const { Connection, Keypair } = require('@solana/web3.js');
  const { AnchorProvider, Wallet } = require('@coral-xyz/anchor');
  
  const conn = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const wallet = new Wallet(Keypair.generate()); // Dummy wallet for reading
  const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  const flashClient = new PerpetualsClient(provider, pc.programId, {});
  flashClient.provider = provider;

  const custodyAccounts = await flashClient.program.account.custody.fetchMultiple([
    collateralCustodyConfig.custodyAccount,
    targetCustodyConfig.custodyAccount,
  ]);

  const collateralCustodyAccount = CustodyAccount.from(collateralCustodyConfig.custodyAccount, custodyAccounts[0]);
  const targetCustodyAccount = CustodyAccount.from(targetCustodyConfig.custodyAccount, custodyAccounts[1]);

  // Calculate collateral and size
  const collateralWithFee = uiDecimalsToNative(collateralUsd.toString(), collateralToken.decimals);
  
  const sizeAmount = flashClient.getSizeAmountFromLeverageAndCollateral(
    collateralWithFee,
    leverage.toString(),
    targetToken,
    collateralToken,
    Side.Short,
    targetPrice,
    targetEmaPrice,
    targetCustodyAccount,
    collateralPrice,
    collateralEmaPrice,
    collateralCustodyAccount,
    BN_ZERO,
  );

  // Calculate price with slippage
  const priceWithSlippage = flashClient.getPriceAfterSlippage(
    true,
    new BN(slippageBps),
    targetPrice,
    Side.Short,
  );

  console.log('\n=== Position Params ===');
  console.log('collateralWithFee:', collateralWithFee.toString());
  console.log('sizeAmount:', sizeAmount.toString());
  console.log('priceWithSlippage:', priceWithSlippage.price.toString(), 'expo:', priceWithSlippage.exponent.toString());
  console.log('side: Short');
  console.log('privilege: Privilege.None =', JSON.stringify(Privilege.None));

  // Also show what the OLD code would have calculated
  const oldSizeAmount = new BN(Math.floor(collateralUsd * leverage * 1e6));
  const oldCollateral = new BN(Math.floor(collateralUsd * 1e6));
  console.log('\n=== OLD (broken) Params for comparison ===');
  console.log('oldCollateral:', oldCollateral.toString());
  console.log('oldSizeAmount:', oldSizeAmount.toString());

  // Check: does the SDK have a different method for building the full IX?
  console.log('\n=== Market Account ===');
  const marketPk = pc.getMarketPk(targetCustodyConfig.custodyAccount, collateralCustodyConfig.custodyAccount, Side.Short);
  console.log('Market PK:', marketPk.toString());
  
  // Check fees
  console.log('\n=== Custody Fees ===');
  console.log('Target openPosition fee:', targetCustodyAccount.fees?.openPosition?.toString());
  console.log('Target closePosition fee:', targetCustodyAccount.fees?.closePosition?.toString());

  // Check min collateral (from on-chain custody)
  console.log('\n=== Trading limits ===');
  console.log('Target tradingConfig:', JSON.stringify({
    maxLeverage: targetCustodyAccount.pricing?.maxLeverage?.toString(),
    maxInitialLeverage: targetCustodyAccount.pricing?.maxInitialLeverage?.toString(),
  }));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
