#!/bin/bash
# Rotate parallax.log when > 50MB
# IMPORTANT: Uses copy+truncate instead of move+replace to preserve file descriptors.
# Pino's transport worker holds an open fd — moving the file breaks logging silently.
LOG_FILE=~/parallax/logs/parallax.log
MAX_SIZE=$((50 * 1024 * 1024))  # 50MB

if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt "$MAX_SIZE" ]; then
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        # Copy current log to archive (preserving original fd)
        cp "$LOG_FILE" "$LOG_FILE.$TIMESTAMP"
        # Truncate in-place — fd stays valid, pino keeps writing
        truncate -s 0 "$LOG_FILE"
        # Compress the archive
        gzip "$LOG_FILE.$TIMESTAMP"
        # Delete archives older than 3 days
        find ~/parallax/logs -name "parallax.log.*.gz" -mtime +3 -delete
        echo "Rotated parallax.log ($SIZE bytes) — copy+truncate method"
    fi
fi
