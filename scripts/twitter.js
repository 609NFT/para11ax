/**
 * Twitter/X utility for Parallax (@para11ax)
 * 
 * Free tier limits (as of 2024):
 * - Posts: 1,500/month (~50/day)
 * - Reads: Very limited
 * 
 * Usage:
 *   node scripts/twitter.js post "Your tweet here"
 *   node scripts/twitter.js test
 */

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function postTweet(text) {
  try {
    const tweet = await client.v2.tweet(text);
    console.log('✅ Tweet posted!');
    console.log('ID:', tweet.data.id);
    console.log('URL: https://x.com/para11ax/status/' + tweet.data.id);
    return tweet;
  } catch (error) {
    console.error('❌ Failed to post:', error.message);
    if (error.data) {
      console.error('Details:', JSON.stringify(error.data, null, 2));
    }
    throw error;
  }
}

async function testConnection() {
  try {
    const me = await client.v2.me();
    console.log('✅ Connected as @' + me.data.username);
    console.log('Name:', me.data.name);
    console.log('ID:', me.data.id);
    return me;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    throw error;
  }
}

// CLI
const [,, command, ...args] = process.argv;

if (command === 'test') {
  testConnection();
} else if (command === 'post') {
  const text = args.join(' ');
  if (!text) {
    console.error('Usage: node scripts/twitter.js post "Your tweet"');
    process.exit(1);
  }
  postTweet(text);
} else {
  console.log('Twitter utility for @para11ax');
  console.log('');
  console.log('Commands:');
  console.log('  test              - Verify API connection');
  console.log('  post "message"    - Post a tweet');
}
