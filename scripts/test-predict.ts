/**
 * Test script for predict system
 * Run with: npx tsx scripts/test-predict.ts
 */

import 'dotenv/config';

async function main() {
  console.log('=== Testing Predict System ===\n');

  // Test 1: Weather Resolver
  console.log('1. Testing Weather Resolver...');
  const { getHighTemperature, parseTemperatureTarget, evaluateTemperatureMarket } = await import('../src/resolvers/weather');
  
  const nycTemp = await getHighTemperature('NYC');
  console.log('   NYC Temperature:', nycTemp);

  const target = parseTemperatureTarget('Will the high temp in NYC be 36-37° on Feb 10, 2026?');
  console.log('   Parsed target:', target);

  if (nycTemp && target) {
    const evaluation = evaluateTemperatureMarket(nycTemp.numericValue, target);
    console.log('   Evaluation:', evaluation);
  }

  // Test 2: DFlow Client
  console.log('\n2. Testing DFlow Client...');
  const { getNearTermMarkets, classifyMarket, isMarketTradeable } = await import('../src/dflow/client');
  
  const markets = await getNearTermMarkets(24);
  console.log(`   Found ${markets.length} markets expiring in 24h`);

  // Filter weather markets
  const weatherMarkets = markets.filter(m => classifyMarket(m) === 'weather');
  console.log(`   Weather markets: ${weatherMarkets.length}`);

  if (weatherMarkets.length > 0) {
    console.log('   Sample weather market:');
    const sample = weatherMarkets[0];
    console.log(`     Title: ${sample.title}`);
    console.log(`     Ticker: ${sample.ticker}`);
    console.log(`     YES Ask: ${sample.yesAsk}`);
    console.log(`     Tradeable: ${isMarketTradeable(sample)}`);
  }

  // Test 3: Opportunity Scanner
  console.log('\n3. Testing Opportunity Scanner...');
  const { scanForOpportunities } = await import('../src/resolvers');
  
  const opportunities = await scanForOpportunities(weatherMarkets, 0.05, 0.7);
  console.log(`   Found ${opportunities.length} opportunities`);

  for (const opp of opportunities.slice(0, 3)) {
    console.log(`\n   Opportunity:`);
    console.log(`     Market: ${opp.market.title.substring(0, 50)}...`);
    console.log(`     Outcome: ${opp.outcome}`);
    console.log(`     Data: ${opp.dataValue} (${opp.dataSource})`);
    console.log(`     Confidence: ${(opp.dataConfidence * 100).toFixed(0)}%`);
    console.log(`     Market Price: ${(opp.marketPrice * 100).toFixed(1)}¢`);
    console.log(`     Edge: ${(opp.edgePct * 100).toFixed(1)}%`);
    console.log(`     Suggested Size: $${opp.suggestedSizeUsd.toFixed(2)}`);
  }

  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
