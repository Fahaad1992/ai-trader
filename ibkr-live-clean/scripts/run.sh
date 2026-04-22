#!/bin/sh
set -eu

export DISPLAY=:1

mkdir -p /root/Jts /root/ibc
cp -f /opt/ibkr-live/config/jts.ini /root/Jts/jts.ini
cp -f /opt/ibkr-live/config/config.ini /root/ibc/config.ini

rm -f /tmp/.X1-lock
Xvfb :1 -ac -screen 0 1024x768x16 &

exec /root/ibc/scripts/ibcstart.sh "${TWS_MAJOR_VRSN}" -g \
     "--tws-path=${TWS_PATH}" \
     "--ibc-path=${IBC_PATH}" \
     "--ibc-ini=${IBC_INI}" \
     "--user=${TWS_USERID}" \
     "--pw=${TWS_PASSWORD}" \
     "--mode=live" \
     "--on2fatimeout=${TWOFA_TIMEOUT_ACTION}"
