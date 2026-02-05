#!/bin/bash
# Start Parallax with Cloudflare Tunnel

echo "🌙 Starting Parallax with web dashboard..."

# Start the tunnel in the background
cloudflared tunnel run parallax &
TUNNEL_PID=$!

# Wait a moment for tunnel to initialize
sleep 2

echo "🌐 Tunnel started - parallax.report should be accessible"
echo ""

# Start the bot (this will also start the web server on port 3000)
npm start

# When npm start exits, also kill the tunnel
kill $TUNNEL_PID 2>/dev/null
