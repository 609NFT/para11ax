#!/usr/bin/env node
/**
 * EC2 Health Check Script
 * Runs via cron, alerts to Discord if thresholds breached
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Thresholds
const THRESHOLDS = {
  diskPercent: 85,      // Alert if disk > 85%
  ramPercent: 90,       // Alert if RAM > 90%
  pm2Restarts: 10,      // Alert if restarts increased by 10+ since last check
  loadAvg1m: 2.0,       // Alert if 1min load avg > 2.0
};

const STATE_FILE = path.join(process.env.HOME, '.openclaw/workspace/memory/ec2-health-state.json');
// Load from .env
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return null;
  }
}

function getDiskUsage() {
  const output = exec("df -h / | tail -1 | awk '{print $5}'");
  return output ? parseInt(output.replace('%', '')) : null;
}

function getRamUsage() {
  const output = exec("free | grep Mem | awk '{print $3/$2 * 100}'");
  return output ? parseFloat(output) : null;
}

function getLoadAvg() {
  const output = exec("cat /proc/loadavg | awk '{print $1}'");
  return output ? parseFloat(output) : null;
}

function getPm2Status() {
  const output = exec("pm2 jlist 2>/dev/null");
  if (!output) return null;
  try {
    const procs = JSON.parse(output);
    const parallax = procs.find(p => p.name === 'parallax');
    if (!parallax) return null;
    return {
      status: parallax.pm2_env.status,
      restarts: parallax.pm2_env.restart_time,
      memory: Math.round(parallax.monit.memory / 1024 / 1024),
      uptime: parallax.pm2_env.pm_uptime
    };
  } catch (e) {
    return null;
  }
}

function getRecentErrors() {
  const output = exec("grep -i 'error\\|exception\\|fatal' ~/parallax/logs/parallax.log 2>/dev/null | tail -3");
  return output || '';
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastRestarts: 0, lastCheck: 0 };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendAlert(message) {
  if (!WEBHOOK_URL) {
    console.log('[ALERT - no webhook]', message);
    return;
  }
  
  try {
    const payload = JSON.stringify({
      content: `🚨 **EC2 Health Alert**\n${message}`
    });
    
    execSync(`curl -s -X POST -H "Content-Type: application/json" -d '${payload.replace(/'/g, "\\'")}' "${WEBHOOK_URL}"`, {
      timeout: 10000
    });
  } catch (e) {
    console.error('Failed to send alert:', e.message);
  }
}

async function main() {
  const state = loadState();
  const alerts = [];
  
  // Disk check
  const diskPercent = getDiskUsage();
  if (diskPercent && diskPercent > THRESHOLDS.diskPercent) {
    alerts.push(`💾 Disk at ${diskPercent}% (threshold: ${THRESHOLDS.diskPercent}%)`);
  }
  
  // RAM check
  const ramPercent = getRamUsage();
  if (ramPercent && ramPercent > THRESHOLDS.ramPercent) {
    alerts.push(`🧠 RAM at ${ramPercent.toFixed(1)}% (threshold: ${THRESHOLDS.ramPercent}%)`);
  }
  
  // Load check
  const loadAvg = getLoadAvg();
  if (loadAvg && loadAvg > THRESHOLDS.loadAvg1m) {
    alerts.push(`⚡ Load avg ${loadAvg} (threshold: ${THRESHOLDS.loadAvg1m})`);
  }
  
  // PM2 check
  const pm2 = getPm2Status();
  if (pm2) {
    if (pm2.status !== 'online') {
      alerts.push(`🔴 Parallax status: ${pm2.status}`);
    }
    
    const restartDelta = pm2.restarts - (state.lastRestarts || 0);
    if (restartDelta >= THRESHOLDS.pm2Restarts && state.lastRestarts > 0) {
      alerts.push(`🔄 ${restartDelta} restarts since last check (was ${state.lastRestarts}, now ${pm2.restarts})`);
    }
    
    state.lastRestarts = pm2.restarts;
  } else {
    alerts.push(`❌ Cannot reach PM2 / Parallax not found`);
  }
  
  // Save state
  state.lastCheck = Date.now();
  saveState(state);
  
  // Send alerts if any
  if (alerts.length > 0) {
    const errors = getRecentErrors();
    let message = alerts.join('\n');
    if (errors) {
      message += `\n\n**Recent errors:**\n\`\`\`\n${errors.slice(0, 500)}\n\`\`\``;
    }
    await sendAlert(message);
    console.log('Alerts sent:', alerts);
  } else {
    console.log('Health check passed:', { diskPercent, ramPercent: ramPercent?.toFixed(1), loadAvg, pm2Status: pm2?.status });
  }
}

main().catch(console.error);
