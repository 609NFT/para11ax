#!/usr/bin/env node
/**
 * Tweet helper - reads tweet text from stdin or --file to avoid shell interpolation issues.
 * Usage:
 *   echo "Tweet text with $100 amounts" | node scripts/tweet.js
 *   node scripts/tweet.js --file /tmp/tweet.txt
 */
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');

async function main() {
  const fileArg = process.argv.indexOf('--file');
  let text;

  if (fileArg !== -1 && process.argv[fileArg + 1]) {
    text = fs.readFileSync(process.argv[fileArg + 1], 'utf-8').trim();
  } else {
    // Read from stdin
    text = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data.trim()));
      // Timeout after 5s in case stdin is empty
      setTimeout(() => resolve(data.trim()), 5000);
    });
  }

  if (!text) {
    console.error('No tweet text provided. Pipe text via stdin or use --file');
    process.exit(1);
  }

  if (text.length > 280) {
    console.error(`Tweet too long: ${text.length} chars (max 280)`);
    process.exit(1);
  }

  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  try {
    const result = await client.v2.tweet(text);
    console.log(`Posted: ${result.data.id}`);
    console.log(`URL: https://x.com/para11ax/status/${result.data.id}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
