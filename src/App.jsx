import { useState, useEffect } from 'react';
import {
  ExternalLink, Loader2, Car, AlertCircle, Clock, Trash2,
  Sparkles, ArrowRight, Settings, X, Check, Star,
} from 'lucide-react';

// Update if you swap models. Free tier on AI Studio.
const MODEL = 'gemini-2.5-flash';

const CATEGORIES = {
  cars: 'cars',
  motorcycles: 'motorcycles',
  trucks: 'trucks',
  commercial: 'commercial',
  scooters: 'scooters',
  watercraft: 'watercraft',
  caravan: 'caravan',
  other: 'others',
};

const GEARBOX = { manual: 101, auto: 102 };
const FUEL = { gasoline: 1100, diesel: 1101, hybrid: 1102, electric: 1103, plugin_hybrid: 1104 };

const PARSE_SYSTEM = `You parse natural-language Yad2 vehicle searches into structured filters AND qualitative criteria. Yad2 is Israel's largest classifieds site. Today is May 2026.

Return ONLY a JSON object. No markdown fences. Schema:
{
  "category": "cars" | "motorcycles" | "trucks" | "commercial" | "scooters" | "watercraft" | "caravan" | "other",
  "manufacturer": string | null,
  "manufacturer_he": string | null,
  "model": string | null,
  "model_he": string | null,
  "year_min": number | null,
  "year_max": number | null,
  "price_min": number | null,
  "price_max": number | null,
  "km_max": number | null,
  "hand_max": number | null,
  "gearbox": "manual" | "auto" | null,
  "fuel": "gasoline" | "diesel" | "hybrid" | "electric" | "plugin_hybrid" | null,
  "area": string | null,
  "semantic_criteria": string | null,
  "interpretation": string
}

Rules:
- "this year"=2026, "last year"=2025
- Prices: handle "k"/"אלף"/"K" as thousands; strip ₪/NIS
- semantic_criteria captures EVERYTHING qualitative not in structured filters: ownership history (single owner, no accidents, dealer vs private), condition (well maintained, garage kept, mint), specific features (sunroof, leather, sport package, AWD), seller type (private, dealer), test/inspection mentions, color preferences, smoke-free, etc.
- Don't invent values. Use null for unspecified.
- interpretation: 1 sentence in the user's language summarizing the search.`;

const EVAL_SYSTEM = `You evaluate Yad2 vehicle listings against a buyer's qualitative criteria. For each listing, score 0-100 how well its visible text matches the criteria. Be strict.

Scoring:
- 80-100: clear positive evidence in the listing text (e.g. "single owner, never in an accident, garage kept" matches "no accidents, garage kept")
- 50-79: partial or weakly implied match
- 30-49: no signal either way (description silent on the criteria)
- 0-29: listing actively conflicts (e.g. multiple hands when buyer wants single owner)

Return ONLY a JSON array. No markdown. Schema:
[{"id": string, "score": number, "reason": string}]

The "reason" must be 1 short sentence in the user's language pointing to specific text or its absence.`;

// ---- Storage ----
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// ---- Backend calls ----
function withToken(url, token) {
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token);
}

async function callGemini(systemPrompt, userContent, maxTokens, proxyUrl, token) {
  const r = await fetch(withToken(`${proxyUrl.replace(/\/$/, '')}/gemini?model=${MODEL}`, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Gemini proxy ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('');
  return text.replace(/```json|```/g, '').trim();
}

async function parsePrompt(prompt, proxyUrl, token) {
  const text = await callGemini(PARSE_SYSTEM, prompt, 1000, proxyUrl, token);
  return JSON.parse(text);
}

async function evaluateListings(criteria, items, proxyUrl, token) {
  if (!criteria || !items.length) return [];
  const slim = items.map(it => ({
    id: String(it.id || it.ad_number || it.token),
    text: [
      it.manufacturer, it.model, it.sub_model,
      it.title, it.title_1, it.title_2,
      it.info_text, it.search_text, it.row_2,
      it.merchant_text, it.description,
      it.year && `year ${it.year}`,
      it.hand != null && `hand ${it.hand}`,
      it.km != null && `${it.km} km`,
    ].filter(Boolean).join(' | '),
  }));
  const prompt = `Buyer criteria: ${criteria}\n\nListings (${slim.length}):\n${JSON.stringify(slim)}`;
  const text = await callGemini(EVAL_SYSTEM, prompt, 3500, proxyUrl, token);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [];
  }
}

async function fetchViaProxy(targetUrl, proxyUrl, token) {
  if (!proxyUrl) throw new Error('Proxy URL not configured');
  const url = withToken(
    `${proxyUrl.replace(/\/$/, '')}/yad2?url=${encodeURIComponent(targetUrl)}`,
    token,
  );
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Yad2 proxy ${r.status}`);
  const ct = r.headers.get('Content-Type') || '';
  if (ct.includes('json')) return r.json();
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function fetchManufacturers(proxyUrl, token, category = 'cars') {
  try {
    const data = await fetchViaProxy(
      `https://gw.yad2.co.il/feed-search-legacy/vehicles/${category}/manufacturers`,
      proxyUrl, token,
    );
    return data?.data || data?.manufacturers || data || null;
  } catch { return null; }
}

async function fetchListings(apiUrl, proxyUrl, token) {
  const data = await fetchViaProxy(apiUrl, proxyUrl, token);
  return data?.data?.feed?.feed_items || data?.feed?.feed_items || data?.results || [];
}

// ---- URL builders ----
function buildYad2WebUrl(filters, manufacturerId) {
  const cat = CATEGORIES[filters.category] || 'cars';
  const params = new URLSearchParams();
  if (manufacturerId) params.set('manufacturer', String(manufacturerId));
  if (filters.year_min || filters.year_max) {
    params.set('year', `${filters.year_min || 1900}-${filters.year_max || 2030}`);
  }
  if (filters.price_min || filters.price_max) {
    params.set('price', `${filters.price_min || 0}-${filters.price_max || 9999999}`);
  }
  if (filters.km_max != null) params.set('km', `0-${filters.km_max}`);
  if (filters.hand_max != null) params.set('hand', `0-${filters.hand_max}`);
  if (filters.gearbox && GEARBOX[filters.gearbox]) params.set('gearBox', String(GEARBOX[filters.gearbox]));
  if (filters.fuel && FUEL[filters.fuel]) params.set('engineType', String(FUEL[filters.fuel]));
  params.set('priceOnly', '1');
  const qs = params.toString();
  return `https://www.yad2.co.il/vehicles/${cat}${qs ? '?' + qs : ''}`;
}

function buildYad2ApiUrl(filters, manufacturerId) {
  const cat = CATEGORIES[filters.category] || 'cars';
  const params = new URLSearchParams();
  if (manufacturerId) params.set('manufacturer', String(manufacturerId));
  if (filters.year_min || filters.year_max) {
    params.set('year', `${filters.year_min || 1900}-${filters.year_max || 2030}`);
  }
  if (filters.price_min || filters.price_max) {
    params.set('price', `${filters.price_min || 0}-${filters.price_max || 9999999}`);
  }
  if (filters.km_max != null) params.set('km', `0-${filters.km_max}`);
  if (filters.hand_max != null) params.set('hand', `0-${filters.hand_max}`);
  if (filters.gearbox && GEARBOX[filters.gearbox]) params.set('gearBox', String(GEARBOX[filters.gearbox]));
  if (filters.fuel && FUEL[filters.fuel]) params.set('engineType', String(FUEL[filters.fuel]));
  params.set('priceOnly', '1');
  return `https://gw.yad2.co.il/feed-search-legacy/vehicles/${cat}?${params.toString()}`;
}

// ---- Helpers ----
const normalizeBrand = (s) => (s || '').toLowerCase().replace(/[\s\-_]/g, '');

function lookupManufacturerId(list, name) {
  if (!list || !name) return null;
  const norm = normalizeBrand(name);
  const arr = Array.isArray(list) ? list : (list.list || list.items || []);
  for (const m of arr) {
    const candidates = [m.title, m.text, m.name, m.englishTitle, m.titleEng, m.label].filter(Boolean);
    for (const c of candidates) {
      const cn = normalizeBrand(c);
      if (cn === norm || cn.includes(norm) || norm.includes(cn)) {
        return m.id ?? m.value ?? m.code;
      }
    }
  }
  return null;
}

const EXAMPLES = [
  "Subaru Forester 2016-2020 under 100k, low km, single owner, no accidents",
  "automatic Toyota Corolla Hybrid 2022+ first hand, max 130k, well maintained",
  "מאזדה 3 ידנית 2018-2021 עד 75 אלף, מצב מצוין, יד ראשונה",
  "BMW 3 series 2019+ diesel, garage kept, no accidents, under 200k",
  "family SUV 2017+, max 80k km, under 90k, reliable, no smokers",
];

// ---- Component ----
export default function App() {
  const [prompt, setPrompt] = useState('');
  const [proxyUrl, setProxyUrl] = useState(import.meta.env.VITE_PROXY_URL || '');
  const [proxyToken, setProxyToken] = useState(import.meta.env.VITE_PROXY_TOKEN || '');
  const [showSettings, setShowSettings] = useState(false);
  const [stage, setStage] = useState(null);
  const [filters, setFilters] = useState(null);
  const [webUrl, setWebUrl] = useState(null);
  const [listings, setListings] = useState(null);
  const [evaluations, setEvaluations] = useState(null);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState([]);
  const [manufacturers, setManufacturers] = useState(null);
  const [manufacturerId, setManufacturerId] = useState(null);

  useEffect(() => {
    const r = ls.get('recent');
    if (r) { try { setRecent(JSON.parse(r)); } catch {} }
    const p = ls.get('proxy');
    if (p) setProxyUrl(p);
    const t = ls.get('proxyToken');
    if (t) setProxyToken(t);
    if (!p && !import.meta.env.VITE_PROXY_URL) setShowSettings(true);
  }, []);

  useEffect(() => {
    if (proxyUrl) {
      fetchManufacturers(proxyUrl, proxyToken).then(setManufacturers);
    }
  }, [proxyUrl, proxyToken]);

  function saveProxy(url, token) {
    setProxyUrl(url);
    setProxyToken(token);
    ls.set('proxy', url);
    if (token) ls.set('proxyToken', token); else ls.del('proxyToken');
  }

  function saveRecent(entry) {
    const next = [entry, ...recent.filter(r => r.prompt !== entry.prompt)].slice(0, 8);
    setRecent(next);
    ls.set('recent', JSON.stringify(next));
  }

  function clearRecent() {
    setRecent([]);
    ls.del('recent');
  }

  async function handleSearch(promptText) {
    const text = (promptText ?? prompt).trim();
    if (!text) return;
    if (!proxyUrl) { setShowSettings(true); return; }

    setError(null); setListings(null); setEvaluations(null);
    setFilters(null); setWebUrl(null); setStage('parsing');

    try {
      const parsed = await parsePrompt(text, proxyUrl, proxyToken);
      setFilters(parsed);

      let mfgList = manufacturers;
      if (!mfgList) {
        mfgList = await fetchManufacturers(proxyUrl, proxyToken, parsed.category || 'cars');
        if (mfgList) setManufacturers(mfgList);
      }
      const mfgId = lookupManufacturerId(mfgList, parsed.manufacturer || parsed.manufacturer_he);
      setManufacturerId(mfgId);

      const web = buildYad2WebUrl(parsed, mfgId);
      const api = buildYad2ApiUrl(parsed, mfgId);
      setWebUrl(web);

      setStage('fetching');
      let items = await fetchListings(api, proxyUrl, proxyToken);

      if (parsed.model) {
        const m = parsed.model.toLowerCase();
        const mh = (parsed.model_he || '').toLowerCase();
        items = items.filter(it => {
          const fields = [it.model, it.sub_model, it.title, it.title_1, it.manufacturer]
            .filter(Boolean).join(' ').toLowerCase();
          return fields.includes(m) || (mh && fields.includes(mh));
        });
      }

      items = items.slice(0, 25);
      setListings(items);

      if (parsed.semantic_criteria && items.length > 0) {
        setStage('evaluating');
        try {
          const evals = await evaluateListings(parsed.semantic_criteria, items, proxyUrl, proxyToken);
          const map = {};
          for (const e of evals) map[String(e.id)] = e;
          setEvaluations(map);
        } catch (e) {
          console.error('eval failed', e);
        }
      }

      saveRecent({ prompt: text, ts: Date.now() });
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setStage(null);
    }
  }

  const fmtPrice = n => n == null ? '' : new Intl.NumberFormat('he-IL').format(n) + ' ₪';
  const fmtKm = n => n == null ? '' : new Intl.NumberFormat('he-IL').format(n) + ' km';

  function listingUrl(it) {
    const token = it.link_token || it.token;
    if (token) return `https://www.yad2.co.il/item/${token}`;
    if (it.id) return `https://www.yad2.co.il/item/${it.id}`;
    return webUrl;
  }

  function listingImg(it) {
    if (it.images?.[0]) return typeof it.images[0] === 'string' ? it.images[0] : it.images[0].src;
    if (it.image?.src) return it.image.src;
    if (typeof it.image === 'string') return it.image;
    return null;
  }

  const sortedListings = (() => {
    if (!listings) return null;
    if (!evaluations) return listings;
    return [...listings].sort((a, b) => {
      const aId = String(a.id || a.ad_number || a.token);
      const bId = String(b.id || b.ad_number || b.token);
      const aS = evaluations[aId]?.score ?? -1;
      const bS = evaluations[bId]?.score ?? -1;
      return bS - aS;
    });
  })();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 pb-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-rose-500 flex items-center justify-center">
            <Car className="w-5 h-5 text-zinc-900" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-tight">Yad2 AI Search</h1>
            <p className="text-xs text-zinc-400">Describe what you want — AI reads each listing</p>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition-colors"
            aria-label="Settings"
          ><Settings className="w-4 h-4" /></button>
        </div>

        {!proxyUrl && !showSettings && (
          <div className="mb-4 p-3 rounded-lg bg-amber-950/40 border border-amber-900/60 text-amber-200 text-sm">
            Configure your proxy URL in settings to search Yad2.
          </div>
        )}

        <div className="relative mb-3">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSearch(); }}
            placeholder="e.g. Subaru Forester 2016-2020 under 100k, single owner, no accidents"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 pr-14 text-sm placeholder-zinc-500 focus:outline-none focus:border-amber-400/50 focus:ring-1 focus:ring-amber-400/20 resize-none"
            rows={3}
            dir="auto"
          />
          <button
            onClick={() => handleSearch()}
            disabled={!!stage || !prompt.trim()}
            className="absolute bottom-3 right-3 w-9 h-9 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-900 flex items-center justify-center transition-colors"
            aria-label="Search"
          >{stage ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}</button>
        </div>

        {stage && (
          <div className="mb-4 p-3 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center gap-2 text-sm text-zinc-300">
            <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
            {stage === 'parsing' && 'Parsing your request...'}
            {stage === 'fetching' && 'Fetching listings from Yad2...'}
            {stage === 'evaluating' && 'AI reading each listing...'}
          </div>
        )}

        {!filters && !stage && proxyUrl && (
          <div className="mb-6">
            <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> Try
            </div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => { setPrompt(ex); handleSearch(ex); }}
                  className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-full px-3 py-1.5 text-zinc-300 transition-colors text-start"
                  dir="auto"
                >{ex}</button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-rose-200 text-sm flex gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {filters && (
          <div className="mb-4 p-4 rounded-xl bg-zinc-900 border border-zinc-800">
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Understood as</div>
            <div className="text-sm text-zinc-100 mb-3" dir="auto">{filters.interpretation}</div>
            <div className="flex flex-wrap gap-1.5">
              {filters.manufacturer && <Chip label={`brand: ${filters.manufacturer}`} warn={!manufacturerId} />}
              {filters.model && <Chip label={`model: ${filters.model}`} info />}
              {filters.year_min && <Chip label={`year ≥ ${filters.year_min}`} />}
              {filters.year_max && <Chip label={`year ≤ ${filters.year_max}`} />}
              {filters.price_min && <Chip label={`≥ ${fmtPrice(filters.price_min)}`} />}
              {filters.price_max && <Chip label={`≤ ${fmtPrice(filters.price_max)}`} />}
              {filters.km_max != null && <Chip label={`km ≤ ${fmtKm(filters.km_max)}`} />}
              {filters.hand_max != null && <Chip label={`hand ≤ ${filters.hand_max}`} />}
              {filters.gearbox && <Chip label={`gearbox: ${filters.gearbox}`} />}
              {filters.fuel && <Chip label={`fuel: ${filters.fuel}`} />}
              {filters.area && <Chip label={`area: ${filters.area}`} info />}
            </div>
            {filters.semantic_criteria && (
              <div className="mt-3 p-2.5 rounded-lg bg-amber-950/30 border border-amber-900/40">
                <div className="text-[10px] text-amber-400/80 uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> AI will check each listing for
                </div>
                <div className="text-xs text-amber-100" dir="auto">{filters.semantic_criteria}</div>
              </div>
            )}
            {webUrl && (
              <a href={webUrl} target="_blank" rel="noopener noreferrer"
                 className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300">
                <ExternalLink className="w-3.5 h-3.5" /> Open this search on Yad2
              </a>
            )}
          </div>
        )}

        {sortedListings != null && (
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center justify-between">
              <span>{sortedListings.length} result{sortedListings.length !== 1 ? 's' : ''}</span>
              {evaluations && (
                <span className="flex items-center gap-1 text-amber-400/70">
                  <Sparkles className="w-3 h-3" /> ranked by AI match
                </span>
              )}
            </div>
            {sortedListings.length === 0 && (
              <div className="text-sm text-zinc-400 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                No matches with these filters. Try widening price or year range.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {sortedListings.map((it, i) => {
                const id = String(it.id || it.ad_number || it.token);
                const evalData = evaluations?.[id];
                return (
                  <a key={id || i} href={listingUrl(it)} target="_blank" rel="noopener noreferrer"
                     className="block bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden hover:border-zinc-700 transition-colors relative">
                    {evalData && <ScoreBadge score={evalData.score} />}
                    {listingImg(it) && (
                      <div className="aspect-video bg-zinc-800 overflow-hidden">
                        <img src={listingImg(it)} alt="" className="w-full h-full object-cover" />
                      </div>
                    )}
                    <div className="p-3" dir="auto">
                      <div className="text-sm font-semibold text-zinc-100 truncate">
                        {[it.manufacturer, it.model].filter(Boolean).join(' ')}
                      </div>
                      {it.sub_model && <div className="text-xs text-zinc-400 truncate">{it.sub_model}</div>}
                      <div className="mt-1.5 flex items-center justify-between">
                        <div className="text-xs text-zinc-400">
                          {[it.year, it.hand != null && `יד ${it.hand}`, it.km != null && fmtKm(it.km)]
                            .filter(Boolean).join(' · ')}
                        </div>
                        <div className="text-sm font-bold text-amber-400">{fmtPrice(it.price)}</div>
                      </div>
                      {it.city && <div className="mt-1 text-xs text-zinc-500 truncate">{it.city}</div>}
                      {evalData?.reason && (
                        <div className="mt-2 pt-2 border-t border-zinc-800 text-[11px] text-zinc-300 flex gap-1.5" dir="auto">
                          <Sparkles className="w-3 h-3 flex-shrink-0 mt-0.5 text-amber-400" />
                          <span>{evalData.reason}</span>
                        </div>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {recent.length > 0 && !stage && (
          <div className="mt-8">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-zinc-500 uppercase tracking-wide flex items-center gap-1">
                <Clock className="w-3 h-3" /> Recent
              </div>
              <button onClick={clearRecent} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            </div>
            <div className="space-y-1.5">
              {recent.map((r, i) => (
                <button key={i} onClick={() => { setPrompt(r.prompt); handleSearch(r.prompt); }}
                  className="w-full text-start text-sm bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-300 truncate transition-colors"
                  dir="auto">{r.prompt}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          proxyUrl={proxyUrl} proxyToken={proxyToken}
          onSave={(url, tok) => { saveProxy(url, tok); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function Chip({ label, warn = false, info = false }) {
  const cls = warn ? 'bg-rose-950/40 border-rose-900/60 text-rose-300'
    : info ? 'bg-sky-950/40 border-sky-900/60 text-sky-300'
    : 'bg-zinc-800 border-zinc-700 text-zinc-200';
  return <span className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

function ScoreBadge({ score }) {
  const color = score >= 70 ? 'bg-emerald-500 text-emerald-950'
    : score >= 50 ? 'bg-amber-400 text-amber-950'
    : score >= 30 ? 'bg-zinc-500 text-zinc-950'
    : 'bg-rose-500 text-rose-950';
  return (
    <div className={`absolute top-2 right-2 z-10 ${color} text-[11px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-lg`}>
      <Star className="w-2.5 h-2.5 fill-current" />{score}
    </div>
  );
}

function SettingsModal({ proxyUrl, proxyToken, onSave, onClose }) {
  const [url, setUrl] = useState(proxyUrl || '');
  const [token, setToken] = useState(proxyToken || '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function testProxy() {
    setTesting(true); setTestResult(null);
    try {
      const t = token ? `&t=${encodeURIComponent(token)}` : '';
      const target = encodeURIComponent('https://gw.yad2.co.il/feed-search-legacy/vehicles/cars?priceOnly=1');
      const r = await fetch(`${url.replace(/\/$/, '')}/yad2?url=${target}${t}`);
      if (r.ok) {
        const ct = r.headers.get('Content-Type') || '';
        setTestResult({ ok: true, msg: `OK (${r.status}, ${ct.split(';')[0] || 'unknown'})` });
      } else {
        setTestResult({ ok: false, msg: `HTTP ${r.status}` });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally { setTesting(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Settings</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-zinc-800 flex items-center justify-center text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Worker URL</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://yad2-ai.steinberg-tech.com"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm focus:outline-none focus:border-amber-400/50" dir="ltr" />
            <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">
              The Cloudflare Worker that proxies Yad2 + Gemini. Endpoints: <code className="bg-zinc-800 px-1 rounded">/yad2</code>, <code className="bg-zinc-800 px-1 rounded">/gemini</code>.
            </p>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Shared token (optional)</label>
            <input type="text" value={token} onChange={e => setToken(e.target.value)}
              placeholder="leave empty if not using"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm focus:outline-none focus:border-amber-400/50" dir="ltr" />
            <p className="mt-1.5 text-xs text-zinc-500">
              Set this if you set <code className="bg-zinc-800 px-1 rounded">PROXY_TOKEN</code> as a Worker secret.
            </p>
          </div>

          {url && (
            <button onClick={testProxy} disabled={testing}
              className="w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Test connection
            </button>
          )}

          {testResult && (
            <div className={`p-2.5 rounded-lg text-xs ${testResult.ok ? 'bg-emerald-950/40 border border-emerald-900/60 text-emerald-200' : 'bg-rose-950/40 border border-rose-900/60 text-rose-200'}`}>
              {testResult.msg}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 bg-zinc-800 hover:bg-zinc-700 rounded-lg py-2.5 text-sm font-medium">Cancel</button>
            <button onClick={() => onSave(url.trim(), token.trim())} disabled={!url.trim()}
              className="flex-1 bg-amber-400 hover:bg-amber-300 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-900 rounded-lg py-2.5 text-sm font-bold">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
