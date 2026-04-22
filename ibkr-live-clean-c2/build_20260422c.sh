#!/bin/bash
set -e
cd /opt/ai-trader/ibkr-live-clean-c2
docker build --no-cache -t ibkr-live-clean:20260422c . > /opt/ai-trader/ibkr-live-clean-c2/build_20260422c.log 2>&1
