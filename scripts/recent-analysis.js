const fs = require('fs');

console.log('🔍 PARALLAX ANALYSIS - Last 48 Hours');
console.log('='.repeat(50));

// Parse trades from trades.log
const tradesLog = fs.readFileSync('/home/ec2-user/parallax/logs/trades.log', 'utf8').trim();
const trades = tradesLog.split('\n').filter(l => l).map(line => JSON.parse(line));

const now = Date.now();
const last48h = now - (48 * 60 * 60 * 1000);
const last24h = now - (24 * 60 * 60 * 1000);

const recent48h = trades.filter(t => t.timestamp >= last48h);
const recent24h = trades.filter(t => t.timestamp >= last24h);

console.log(`\n📊 TRADE SUMMARY:`);
console.log(`Last 48h: ${recent48h.length} trades`);
console.log(`Last 24h: ${recent24h.length} trades`);

if (trades.length > 0) {
  const lastTrade = trades[trades.length - 1];
  const lastTradeAge = Math.round((now - lastTrade.timestamp) / 1000 / 60);
  console.log(`Last trade: ${lastTradeAge} minutes ago (${lastTrade.side})`);
}

// Check for entry opportunities in parallax.log
const mainLog = fs.readFileSync('/home/ec2-user/parallax/logs/parallax.log', 'utf8');
const logLines = mainLog.split('\n').filter(l => l);

const entryOpportunities = [];
const recentEvals = [];

for (const line of logLines) {
  try {
    const log = JSON.parse(line);
    
    if (log.msg && log.msg.includes('Entry opportunity detected') && log.time >= last48h) {
      entryOpportunities.push(log);
    }
    
    if (log.msg === 'getBestOpportunity evaluation summary' && log.time >= last24h) {
      recentEvals.push(log);
    }
  } catch (e) {
    // Skip invalid JSON lines
  }
}

console.log(`\n🎯 OPPORTUNITIES (Last 48h):`);
console.log(`Entry opportunities detected: ${entryOpportunities.length}`);

if (entryOpportunities.length > 0) {
  // Group by symbol
  const bySymbol = {};
  entryOpportunities.forEach(opp => {
    const symbol = opp.token || opp.ticker;
    if (!bySymbol[symbol]) bySymbol[symbol] = [];
    bySymbol[symbol].push(opp);
  });
  
  Object.entries(bySymbol).forEach(([symbol, opps]) => {
    const latest = opps[opps.length - 1];
    const discount = latest.discount;
    const threshold = latest.entryThreshold;
    const ageMin = Math.round((now - latest.time) / 1000 / 60);
    console.log(`  ${symbol}: ${discount}% (threshold: ${threshold}%) - ${ageMin}min ago`);
  });
}

console.log(`\n🔄 EVALUATION LOOP:`);
if (recentEvals.length > 0) {
  const latest = recentEvals[recentEvals.length - 1];
  const ageMin = Math.round((now - latest.time) / 1000 / 60);
  console.log(`Last evaluation: ${ageMin} minutes ago`);
  console.log(`Symbols evaluated: ${latest.totalEvaluated}`);
  console.log(`Above threshold: ${latest.aboveThreshold}`);
  console.log(`Valid signals: ${latest.validSignals}`);
} else {
  console.log('No recent evaluations found');
}

// Check for any error patterns
const errors = [];
for (const line of logLines) {
  try {
    const log = JSON.parse(line);
    if (log.level >= 50 && log.time >= last24h) { // Error level
      errors.push(log);
    }
  } catch (e) {
    // Skip invalid JSON lines
  }
}

if (errors.length > 0) {
  console.log(`\n🚨 ERRORS (Last 24h): ${errors.length}`);
  errors.slice(-3).forEach(err => {
    const ageMin = Math.round((now - err.time) / 1000 / 60);
    console.log(`  ${err.msg || err.error || 'Unknown error'} (${ageMin}min ago)`);
  });
}

console.log(`\n✅ Analysis complete`);