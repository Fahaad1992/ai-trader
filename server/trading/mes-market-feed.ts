import { execFileSync } from 'node:child_process';

const API_BASE = process.env.TASTYTRADE_API_BASE || 'https://api.tastyworks.com';
const SESSION_TOKEN = process.env.TASTYTRADE_SESSION_TOKEN;
const MES_SYMBOL = process.env.MES_SYMBOL || '/MESM6';
const SOURCE = 'tastytrade-dxfeed';

if (!SESSION_TOKEN) {
  throw new Error('Missing TASTYTRADE_SESSION_TOKEN');
}

const wsCtor = (globalThis as any).WebSocket;
if (!wsCtor) {
  throw new Error('Global WebSocket is not available in this runtime');
}

interface MesFeedReading {
  symbol: string;
  streamerSymbol: string;
  source: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  timestamp: string | null;
}

async function apiGet(path: string) {
  const url = `${API_BASE}${path}`;
  const output = execFileSync('curl', [
    '-sS',
    '-H', `Authorization: ${SESSION_TOKEN}`,
    '-H', 'Accept: application/json',
    url,
  ], { encoding: 'utf8' });

  const payload = output ? JSON.parse(output) : null;
  if (payload?.error) {
    throw new Error(`API ${path} failed: ${JSON.stringify(payload.error)}`);
  }
  return payload;
}

async function getQuoteAccess() {
  const payload = await apiGet('/api-quote-tokens');
  return payload.data as { token: string; 'dxlink-url': string };
}

async function getMesStreamerSymbol(symbol: string) {
  const payload = await apiGet(`/instruments/futures?symbol=${encodeURIComponent(symbol)}`);
  const item = payload?.data?.items?.[0];
  if (!item?.['streamer-symbol']) {
    throw new Error(`Streamer symbol not found for ${symbol}`);
  }
  return item['streamer-symbol'] as string;
}

export async function readMesDxFeed(): Promise<MesFeedReading> {
  const quoteAccess = await getQuoteAccess();
  const streamerSymbol = await getMesStreamerSymbol(MES_SYMBOL);

  return await new Promise<MesFeedReading>((resolve, reject) => {
    const reading: MesFeedReading = {
      symbol: MES_SYMBOL,
      streamerSymbol,
      source: SOURCE,
      last: null,
      bid: null,
      ask: null,
      timestamp: null,
    };

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`DXFeed timeout for ${streamerSymbol}`));
    }, 30000);

    const ws = new wsCtor(quoteAccess['dxlink-url']);

    const finishIfReady = () => {
      if (reading.last != null && reading.bid != null && reading.ask != null) {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(reading);
      }
    };

    const stamp = (value: unknown) => {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : new Date().toISOString();
    };

    const send = (payload: unknown) => ws.send(JSON.stringify(payload));

    ws.addEventListener('open', () => {
      send({
        type: 'SETUP',
        channel: 0,
        version: 'mes-market-feed/1.0.0',
        keepaliveTimeout: 60,
        acceptKeepaliveTimeout: 60,
      });
    });

    ws.addEventListener('message', (event: any) => {
      const text = String(event.data ?? '');
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === 'AUTH_STATE' && msg.state === 'UNAUTHORIZED') {
        send({ type: 'AUTH', channel: 0, token: quoteAccess.token });
        return;
      }

      if (msg.type === 'AUTH_STATE' && msg.state === 'AUTHORIZED') {
        send({ type: 'CHANNEL_REQUEST', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } });
        return;
      }

      if (msg.type === 'CHANNEL_OPENED' && msg.channel === 3) {
        send({
          type: 'FEED_SETUP',
          channel: 3,
          acceptAggregationPeriod: 0.1,
          acceptDataFormat: 'COMPACT',
          acceptEventFields: {
            Trade: ['eventType', 'eventSymbol', 'eventTime', 'price', 'dayVolume', 'size'],
            Quote: ['eventType', 'eventSymbol', 'eventTime', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
          },
        });
        return;
      }

      if (msg.type === 'FEED_CONFIG' && msg.channel === 3) {
        send({
          type: 'FEED_SUBSCRIPTION',
          channel: 3,
          reset: true,
          add: [
            { type: 'Trade', symbol: streamerSymbol },
            { type: 'Quote', symbol: streamerSymbol },
          ],
        });
        return;
      }

      if (msg.type === 'FEED_DATA' && msg.channel === 3 && Array.isArray(msg.data)) {
        const [eventType, payload] = msg.data;
        if (!Array.isArray(payload) || payload[0] !== eventType) return;

        if (eventType === 'Trade') {
          const [, eventSymbol, eventTime, price] = payload;
          if (eventSymbol === streamerSymbol && typeof price === 'number') {
            reading.last = price;
            reading.timestamp = stamp(eventTime);
            console.log(`[${SOURCE}] trade ${streamerSymbol} last=${price} timestamp=${reading.timestamp}`);
            finishIfReady();
          }
          return;
        }

        if (eventType === 'Quote') {
          const [, eventSymbol, eventTime, bidPrice, askPrice] = payload;
          if (eventSymbol === streamerSymbol) {
            if (typeof bidPrice === 'number') reading.bid = bidPrice;
            if (typeof askPrice === 'number') reading.ask = askPrice;
            reading.timestamp = stamp(eventTime);
            console.log(`[${SOURCE}] quote ${streamerSymbol} bid=${reading.bid} ask=${reading.ask} timestamp=${reading.timestamp}`);
            finishIfReady();
          }
        }
      }
    });

    ws.addEventListener('error', (err: any) => {
      clearTimeout(timeout);
      reject(new Error(`DXFeed websocket error: ${err?.message || String(err)}`));
    });

    ws.addEventListener('close', () => {
      // no-op; resolve/reject are handled elsewhere
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readMesDxFeed()
    .then((reading) => {
      console.log(JSON.stringify(reading));
      process.exit(0);
    })
    .catch((error) => {
      console.error(String(error?.message || error));
      process.exit(1);
    });
}
