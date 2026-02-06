#!/bin/bash
# Deploy script that FORCES deployment summary before reload

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Check if summary message was provided
if [ -z "$1" ]; then
    echo -e "${RED}ERROR: Deployment summary required${NC}"
    echo "Usage: ./scripts/deploy.sh \"Your deployment summary here\""
    echo ""
    echo "Example:"
    echo "  ./scripts/deploy.sh \"MIN_FLOOR 4.0 → 4.3% based on backtest\""
    exit 1
fi

SUMMARY="$1"
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "uncommitted")

echo -e "${GREEN}Building...${NC}"
npm run build

echo -e "${GREEN}Posting to #deployments...${NC}"
# This will be called by the agent - can't post directly from bash without webhook
echo "DEPLOY_SUMMARY: $SUMMARY"
echo "DEPLOY_COMMIT: $COMMIT"

echo -e "${GREEN}Reloading PM2...${NC}"
pm2 reload parallax

echo -e "${GREEN}Done!${NC}"
