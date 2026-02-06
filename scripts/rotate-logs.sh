#!/bin/bash
# Rotate parallax.log when > 50MB
LOG_FILE=~/parallax/logs/parallax.log
MAX_SIZE=$((50 * 1024 * 1024))  # 50MB

if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt "$MAX_SIZE" ]; then
        # Keep last 10K lines, archive rest
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        tail -n 10000 "$LOG_FILE" > "$LOG_FILE.tmp"
        mv "$LOG_FILE" "$LOG_FILE.$TIMESTAMP"
        mv "$LOG_FILE.tmp" "$LOG_FILE"
        gzip "$LOG_FILE.$TIMESTAMP"
        # Delete archives older than 3 days
        find ~/parallax/logs -name "parallax.log.*.gz" -mtime +3 -delete
        echo "Rotated parallax.log ($SIZE bytes)"
    fi
fi
