#!/bin/bash
# Check Parallax logs for real errors (not warnings or known noise)

LOG_FILE="logs/pm2-out.log"
ERR_FILE="logs/pm2-error.log"
LINES=100

# Real errors to catch (case insensitive)
ERROR_PATTERNS="FATAL|CIRCUIT.BREAKER|CRITICAL|uncaught|unhandled|ECONNREFUSED|ETIMEDOUT|insufficient.*funds|execution.*failed"

# Noise to filter out (not real errors)
NOISE_PATTERNS="bigint|percentile.*skipped|timeout or error.*TVL|Failed to load bindings"

echo "=== Checking last $LINES lines for errors ==="

# Check stdout log
if [ -f "$LOG_FILE" ]; then
    ERRORS=$(tail -$LINES "$LOG_FILE" 2>/dev/null | grep -iE "$ERROR_PATTERNS" | grep -ivE "$NOISE_PATTERNS")
    if [ -n "$ERRORS" ]; then
        echo "ERRORS in pm2-out.log:"
        echo "$ERRORS"
    fi
fi

# Check stderr log  
if [ -f "$ERR_FILE" ]; then
    ERRORS=$(tail -$LINES "$ERR_FILE" 2>/dev/null | grep -ivE "$NOISE_PATTERNS")
    if [ -n "$ERRORS" ]; then
        echo "ERRORS in pm2-error.log:"
        echo "$ERRORS" | tail -5
    fi
fi

# If nothing found
if [ -z "$ERRORS" ]; then
    echo "OK - No critical errors found"
fi
