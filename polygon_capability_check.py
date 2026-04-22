import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENV_PATH = Path('/opt/ai-trader/.env')

def load_key():
    text = ENV_PATH.read_text(encoding='utf-8')
    for line in text.splitlines():
        m = re.match(r'^POLYGON_API_KEY=(.*)$', line.strip())
        if m:
            return m.group(1)
    raise RuntimeError('POLYGON_API_KEY not found')

KEY = load_key()

def get(url: str):
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode('utf-8', 'replace')
            try:
                data = json.loads(body)
            except Exception:
                data = {'raw': body[:500]}
            return {'http_status': r.status, 'data': data}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            data = json.loads(body)
        except Exception:
            data = {'raw': body[:500]}
        return {'http_status': e.code, 'data': data}
    except Exception as e:
        return {'http_status': None, 'data': {'error': str(e)}}

out = {'checked_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

snap = get(f'https://api.polygon.io/v3/snapshot/options/SPY?limit=1&apiKey={KEY}')
out['snapshot_spy'] = {
    'http_status': snap['http_status'],
    'keys': sorted(list(snap['data'].keys()))[:20],
    'count': len(snap['data'].get('results', []) or []),
}
spy_ticker = None
if snap['data'].get('results'):
    first = snap['data']['results'][0]
    details = first.get('details', {}) or {}
    spy_ticker = details.get('ticker') or first.get('ticker')
    out['snapshot_spy'].update({
        'sample_ticker': spy_ticker,
        'has_greeks': bool(first.get('greeks')),
        'last_quote_present': bool(first.get('last_quote')),
        'last_trade_present': bool(first.get('last_trade')),
        'fmv_present': 'fmv' in first,
        'underlying_present': bool(first.get('underlying_asset')),
    })

spx = get('https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=' + urllib.parse.quote('I:SPX') + f'&limit=1&apiKey={KEY}')
out['spx_reference'] = {
    'http_status': spx['http_status'],
    'keys': sorted(list(spx['data'].keys()))[:20],
    'count': len(spx['data'].get('results', []) or []),
}
if spx['data'].get('results'):
    out['spx_reference']['sample_ticker'] = (spx['data']['results'][0] or {}).get('ticker')
else:
    out['spx_reference']['message'] = spx['data'].get('error') or spx['data'].get('message') or spx['data'].get('status')

if spy_ticker:
    t = urllib.parse.quote(spy_ticker)
    trades = get(f'https://api.polygon.io/v3/trades/{t}?limit=1&order=desc&sort=timestamp&apiKey={KEY}')
    out['trades_spy_option'] = {
        'http_status': trades['http_status'],
        'keys': sorted(list(trades['data'].keys()))[:20],
        'count': len(trades['data'].get('results', []) or []),
        'message': trades['data'].get('error') or trades['data'].get('message') or trades['data'].get('status'),
    }
    quotes = get(f'https://api.polygon.io/v3/quotes/{t}?limit=1&order=desc&sort=timestamp&apiKey={KEY}')
    out['quotes_spy_option'] = {
        'http_status': quotes['http_status'],
        'keys': sorted(list(quotes['data'].keys()))[:20],
        'count': len(quotes['data'].get('results', []) or []),
        'message': quotes['data'].get('error') or quotes['data'].get('message') or quotes['data'].get('status'),
    }

print(json.dumps(out, indent=2))
