#!/usr/bin/env node
/**
 * Auto-deploy script that summarizes and posts to #deployments
 * Also auto-captures to memory files for continuity
 * 
 * Usage: node scripts/deploy.js "Optional extra context"
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DEPLOYMENTS_WEBHOOK = process.env.DISCORD_DEPLOYMENTS_WEBHOOK_URL;
const MEMORY_DIR = path.join(process.env.HOME, '.openclaw/workspace/memory');

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getTime() {
  return new Date().toISOString().split('T')[1].substring(0, 5);
}

function captureToMemory({ commit, commitMsg, filesChanged, constantsChanges, extraContext }) {
  const today = getToday();
  const time = getTime();
  const filePath = path.join(MEMORY_DIR, `${today}.md`);
  
  // Ensure memory dir exists
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
  
  // Create file with header if new
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${today} — Session Notes\n`);
  }
  
  // Format the entry
  const files = filesChanged.split('\n').filter(f => f).slice(0, 8);
  let entry = `\n## Deploy: ${commitMsg.split('\n')[0]} (${time} UTC)\n`;
  entry += `**Commit**: \`${commit}\`\n`;
  if (files.length > 0) {
    entry += `**Files**: ${files.join(', ')}\n`;
  }
  if (constantsChanges) {
    entry += `**Parameters**: ${constantsChanges.replace(/\*\*/g, '').replace('Constants:', '').trim()}\n`;
  }
  if (extraContext) {
    entry += `**Context**: ${extraContext}\n`;
  }
  
  fs.appendFileSync(filePath, entry);
  console.log(`\x1b[32mCaptured to memory ✓\x1b[0m (${filePath})`);
}

async function deploy() {
  const extraContext = process.argv.slice(2).join(' ');

  // Get commit info
  let commit = 'uncommitted';
  let commitMsg = '';
  let filesChanged = '';
  
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    commitMsg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
    filesChanged = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('Warning: Could not get git info');
  }

  // Get key changes from constants.ts if modified
  let constantsChanges = '';
  if (filesChanged.includes('constants.ts')) {
    try {
      const diff = execSync('git diff HEAD~1 HEAD -- src/constants.ts 2>/dev/null | head -50', { encoding: 'utf8' });
      const minFloorMatch = diff.match(/MIN_FLOOR:\s*([\d.]+)/g);
      if (minFloorMatch) {
        constantsChanges = `\n**Constants:** ${minFloorMatch.join(' → ')}`;
      }
    } catch (e) {}
  }

  // Build
  console.log('\x1b[32mBuilding...\x1b[0m');
  execSync('npm run build', { stdio: 'inherit' });

  // Auto-generate summary
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const fileList = filesChanged.split('\n').filter(f => f).slice(0, 5).map(f => `• ${f}`).join('\n');
  
  let message = `🚀 **Deployment: \`${commit}\`** — ${timestamp}\n\n`;
  message += `**Commit:** ${commitMsg}\n\n`;
  if (fileList) message += `**Files:**\n${fileList}\n`;
  if (constantsChanges) message += constantsChanges + '\n';
  if (extraContext) message += `\n**Context:** ${extraContext}`;

  // Post to Discord (via webhook if available, otherwise output for agent to post)
  if (DEPLOYMENTS_WEBHOOK) {
    console.log('\x1b[32mPosting to #deployments...\x1b[0m');
    try {
      const res = await fetch(DEPLOYMENTS_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message })
      });
      if (res.ok) {
        console.log('\x1b[32mPosted to Discord ✓\x1b[0m');
      } else {
        console.log('\x1b[33mDiscord post failed:', res.status, '\x1b[0m');
      }
    } catch (e) {
      console.error('\x1b[33mWarning: Failed to post to Discord\x1b[0m', e.message);
    }
  } else {
    // Output in a format the agent can parse and post
    console.log('\x1b[33m--- DEPLOYMENT_SUMMARY_START ---\x1b[0m');
    console.log(message);
    console.log('\x1b[33m--- DEPLOYMENT_SUMMARY_END ---\x1b[0m');
    console.log('\x1b[33mNo webhook - agent should post above to #deployments (1469126610908352593)\x1b[0m');
  }

  // Capture to memory (auto-documentation)
  captureToMemory({ commit, commitMsg, filesChanged, constantsChanges, extraContext });

  // Push to both repos (keep them in sync)
  console.log('\x1b[32mPushing to both repos...\x1b[0m');
  try {
    execSync('git push origin main', { stdio: 'inherit' });
    execSync('git push private main 2>/dev/null || true', { stdio: 'inherit' });
    console.log('\x1b[32mRepos synced ✓\x1b[0m');
  } catch (e) {
    console.log('\x1b[33mWarning: Git push failed - continuing with deploy\x1b[0m');
  }

  // Reload
  console.log('\x1b[32mReloading PM2...\x1b[0m');
  execSync('pm2 reload parallax', { stdio: 'inherit' });

  console.log('\x1b[32m\nDeployment complete!\x1b[0m');
}

deploy().catch(e => {
  console.error('\x1b[31mDeployment failed:\x1b[0m', e.message);
  process.exit(1);
});
