#!/bin/bash
set -e
cd /opt/ai-trader/ibkr-live-clean

docker build --no-cache -t ibkr-live-clean:20260422b . > /opt/ai-trader/ibkr-live-clean/rebuild_20260422b.log 2>&1

docker rm -f ib-gateway-live >/dev/null 2>&1 || true

docker run -d \
  --name ib-gateway-live \
  --restart always \
  -p 127.0.0.1:4001:4001 \
  -v /opt/ai-trader/ibkr-live-clean/config:/opt/ibkr-live/config:ro \
  -v /opt/ai-trader/ibkr-live-clean/state:/root/Jts \
  -e TWS_USERID=Fahaad306 \
  -e TWS_PASSWORD=Ff097531 \
  ibkr-live-clean:20260422b >> /opt/ai-trader/ibkr-live-clean/rebuild_20260422b.log 2>&1

sleep 25
{
  echo '===DOCKER_PS===' 
  docker ps -a --filter name=ib-gateway-live --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
  echo '===SS_4001===' 
  ss -tlnp | grep 4001 || true
  echo '===TAIL_LOGS===' 
  docker logs --tail 200 ib-gateway-live 2>&1 || true
} >> /opt/ai-trader/ibkr-live-clean/rebuild_20260422b.log 2>&1
