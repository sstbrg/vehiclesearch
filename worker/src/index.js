const ALLOWED_YAD2 = [
  'https://gw.yad2.co.il/',
  'https://www.yad2.co.il/',
  'https://m.yad2.co.il/',
  'https://api.yad2.co.il/',
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Optional shared-secret gate
    if (env.PROXY_TOKEN) {
      const token = url.searchParams.get('t') || request.headers.get('X-Proxy-Token');
      if (token !== env.PROXY_TOKEN) {
        return json({ error: 'forbidden' }, 403);
      }
    }

    if (url.pathname === '/yad2' || url.pathname === '/yad2/') {
      return handleYad2(url, env);
    }
    if (url.pathname === '/gemini' || url.pathname === '/gemini/') {
      return handleGemini(request, url, env);
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, endpoints: ['/yad2', '/gemini'] });
    }
    return json({ error: 'not found' }, 404);
  },
};

// Headers + cookies cribbed from TamirMa/yad2listings (MIT). These slip past
// Radware Bot Manager (the "ShieldSquare Captcha" page) where a vanilla worker
// fetch gets blocked. The cookies are generic site flags (cohort, A/B bucket,
// "use elastic search" routing) — not bot-mitigation tokens.
const YAD2_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
  'Cache-Control': 'max-age=0',
  'Connection': 'keep-alive',
  'DNT': '1',
  'Referer': 'https://www.yad2.co.il/',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Cookie': '__ssds=3; y2018-2-cohort=88; use_elastic_search=1; abTestKey=2; cohortGroup=D',
};

async function handleYad2(url, env) {
  const target = url.searchParams.get('url');
  const extract = url.searchParams.get('extract');
  if (!target || !ALLOWED_YAD2.some(p => target.startsWith(p))) {
    return json({ error: 'bad target URL' }, 400);
  }
  try {
    const upstream = await fetch(target, {
      headers: YAD2_HEADERS,
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    if (extract === 'next') {
      const html = await upstream.text();
      const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) {
        return json({
          error: 'no __NEXT_DATA__ found in page',
          upstreamStatus: upstream.status,
          contentType: upstream.headers.get('Content-Type'),
          snippet: html.slice(0, 400),
        }, 502);
      }
      let parsed;
      try { parsed = JSON.parse(m[1]); }
      catch (e) { return json({ error: 'parse __NEXT_DATA__ failed', message: e.message }, 502); }
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleGemini(request, url, env) {
  if (request.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY secret not set' }, 500);
  }
  const model = url.searchParams.get('model') || DEFAULT_GEMINI_MODEL;
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    return json({ error: 'invalid model name' }, 400);
  }
  try {
    const body = await request.text();
    const upstream = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body,
    });
    const respText = await upstream.text();
    return new Response(respText, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
