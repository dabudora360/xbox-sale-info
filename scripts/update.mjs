// Xboxセール情報 自動更新スクリプト（依存ライブラリなし / Node 18+）
// 1. Microsoft Store のセール一覧ページから対象商品IDを全件取得
// 2. DisplayCatalog API で価格・定価・開始/終了日時・日英タイトル・表紙を補完
// 3. index.html の ITEMS / PREV_IDS / 日時・件数・出典表記を差し替える
// 4. 価格履歴（price-history.json）に今日の価格を記録し、グラフ用データを index.html へ埋め込む
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'index.html');

const DEALS_URL = 'https://www.microsoft.com/ja-jp/store/deals/games/xbox';
const DEALS_URL_US = 'https://www.microsoft.com/en-us/store/deals/games/xbox';
const CATALOG = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'ja-JP' };

// 表紙の掲載が見送られた商品（内容チェックで弾かれたもの）。タイトル表示のプレースホルダになる
const NO_COVER = new Set(['9PGL25P5ZCSJ', '9PF0B4L7Q9D6', '9NLJVL7RC4JR', '9N951JR9T3FX', '9NSW13NTBJHW', '9MSVPJCHHRPR', 'C52WCN7GNXR3']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} ${url}`);
    } catch (e) { last = e; }
    await sleep(1000 * (i + 1));
  }
  throw last;
}

// 文字列内を考慮しながら [ ... ] の範囲を取り出す
function extractArray(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = html.indexOf('[', start);
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return { text: html.slice(open, i + 1), open, close: i };
  }
  throw new Error(`array not closed: ${marker}`);
}

// ---- ソース: Microsoft Store セール一覧ページ ----
async function fetchDealsIds(baseUrl = DEALS_URL) {
  // MS側の応答で totalProducts が揺れる（例: 2275 と 2181 が混在し、ページの並びも
  // 応答ごとにずれる）ため、1回の走査では取りこぼす。最大3回走査して和集合を取る。
  const ids = [];
  const seen = new Set();
  let total = 0;
  for (let sweep = 0; sweep < 3; sweep++) {
    const before = seen.size;
    for (let skip = 0; skip < 10000 && (total === 0 || skip <= total); skip += 50) {
      const url = skip === 0 ? baseUrl : `${baseUrl}?skip=${skip}`;
      const res = await fetchRetry(url, { headers: UA });
      const html = await res.text();
      const t = Number(html.match(/"totalProducts":(\d+)/)?.[1] || 0);
      if (t > total) total = t;
      for (const m of html.matchAll(/\\?"productId\\?":\\?"([0-9A-Za-z]{12})\\?"/g)) {
        const id = m[1].toUpperCase();
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    if (seen.size === before) break;
  }
  return { ids, total: total || ids.length };
}

// ---- DisplayCatalog で商品情報を補完 ----
function pickPriceAndDates(product, currency = 'JPY') {
  let best = null;
  for (const dsa of product.DisplaySkuAvailabilities || []) {
    if (dsa.Sku?.SkuType !== 'full') continue;
    for (const av of dsa.Availabilities || []) {
      const price = av.Price || av.OrderManagementData?.Price;
      if (!price || price.CurrencyCode !== currency || !(price.MSRP > 0)) continue;
      if (!(av.Actions || []).includes('Purchase')) continue;
      if (!best || price.ListPrice < best.price.ListPrice) best = { price, cond: av.Conditions || {} };
    }
  }
  return best;
}
function pickImage(lp) {
  const imgs = lp.Images || [];
  for (const purpose of ['Poster', 'BoxArt', 'FeaturePromotionalSquareArt']) {
    const hit = imgs.find((i) => i.ImagePurpose === purpose);
    if (hit?.Uri) return `https:${hit.Uri}?w=512`;
  }
  return null;
}
function slugify(en) {
  const s = en.toLowerCase().replace(/[''’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'x';
}
async function fetchCatalog(ids, lang, market = 'JP') {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await fetchRetry(`${CATALOG}?bigIds=${chunk.join(',')}&market=${market}&languages=${lang}`, { headers: UA });
    const j = await res.json();
    for (const p of j.Products || []) map.set(p.ProductId, p);
    await sleep(150);
  }
  return map;
}

// ---- Game Pass 収録タイトル（公式カタログのリスト群） ----
const GP_SIGLS = [
  'f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e', // コンソール全タイトル
  '609d944c-d395-4c0a-9ea4-e9f39b52c1ad', // PC 全タイトル
  'b8900d09-a491-44cc-916e-32b5acae621b', // EA Play（コンソール）
  '1d33fbb9-b895-4732-a8ca-a55c8b99fa2c', // EA Play（PC）
  'aed03b50-b954-4ee4-a426-fe1686b64f85', // Ubisoft+（コンソール）
  '7def2ea6-d4d8-405b-83cf-4e7229a7bf93', // Ubisoft+（PC）
];
async function fetchGamePassIds(market = 'JP', langTag = 'ja-jp') {
  const set = new Set();
  for (const id of GP_SIGLS) {
    try {
      const res = await fetchRetry(`https://catalog.gamepass.com/sigls/v2?id=${id}&language=${langTag}&market=${market}`, { headers: UA });
      const j = await res.json();
      for (const x of j || []) if (x && x.id) set.add(String(x.id).toUpperCase());
    } catch (e) { console.log(`Game Passリスト取得に失敗 (${id}): ${e.message}`); }
  }
  return set;
}

// ---- DLC単品の推定（カタログに種別項目が無いためタイトルから判定。本体・バンドルは除外） ----
const DLC_KW = /(アップグレード|アドオン|シーズンパス|拡張|エクスパンション|追加コンテンツ|追加シナリオ|upgrade|add-on|add on|season pass|expansion|\bdlc\b)/i;
const BUNDLE_KW = /(バンドル|コレクション|bundle|collection)/i;
function isStandaloneDlc(title, enTitle) {
  const s = `${title} ${enTitle || ''}`;
  if (s.includes('+')) return false;
  if (BUNDLE_KW.test(s)) return false;
  return DLC_KW.test(s);
}

function nowJstLabel() {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}年${Number(v.month)}月${Number(v.day)}日 ${v.hour}:${v.minute}`;
}
const fmtNum = (n) => n.toLocaleString('en-US');

// JST の yyyy-mm-dd
function jstDateOf(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

async function main() {
  let html = readFileSync(INDEX, 'utf8');
  const itemsSpan = extractArray(html, 'var ITEMS =');
  const oldItems = JSON.parse(itemsSpan.text);
  let oldUsItems = [];
  try { oldUsItems = JSON.parse(extractArray(html, 'var ITEMS_US =').text); } catch { oldUsItems = []; }
  let oldUsCov = [0, 0, 0];
  const covM = html.match(/var US_COV = \[([\d,\s]*)\];/);
  if (covM) oldUsCov = covM[1].split(',').map((v) => Number(v.trim()) || 0);
  const oldIds = oldItems.map((it) => it.id);
  const oldTs = html.match(/価格は (\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2})（日本時間）時点/)?.[1];
  if (!oldTs) throw new Error('現在のデータ日時が見つかりません');

  const { ids, total } = await fetchDealsIds();
  console.log(`ソース: Microsoft Store セール一覧 / 対象 ${total} 件 / ID取得 ${ids.length} 件`);
  if (ids.length < 10) throw new Error('商品IDをほとんど取得できませんでした。中断します');

  const [ja, en] = [await fetchCatalog(ids, 'ja-JP'), await fetchCatalog(ids, 'en-US')];
  // 実績データ（ta-extras.json があればマージする）
  let extras = {};
  try { extras = JSON.parse(readFileSync(join(ROOT, 'ta-extras.json'), 'utf8')); } catch { extras = {}; }
  const gpSet = await fetchGamePassIds();
  console.log(`Game Pass収録リスト ${gpSet.size} 件`);

  const items = [];
  let dropped = 0;
  for (const id of ids) {
    const p = ja.get(id);
    const lp = p?.LocalizedProperties?.[0];
    const picked = p ? pickPriceAndDates(p) : null;
    if (!p || !lp || !picked) { dropped++; continue; }
    const price = picked.price.ListPrice;
    const msrp = picked.price.MSRP;
    const pct = Math.round((1 - price / msrp) * 100);
    if (pct <= 0) { dropped++; continue; }
    const enTitle = en.get(id)?.LocalizedProperties?.[0]?.ProductTitle || lp.ProductTitle;
    const item = {
      id,
      t: lp.ProductTitle,
      en: enTitle,
      pub: lp.PublisherName || '',
      p: price,
      m: msrp,
      pct,
      end: picked.cond.EndDate,
      url: `https://www.xbox.com/ja-JP/games/store/${slugify(enTitle)}/${id}`,
      start: picked.cond.StartDate,
    };
    const img = NO_COVER.has(id) ? null : pickImage(lp);
    if (img) item.img = img;
    if (gpSet.has(id)) item.gp = 1;
    if (isStandaloneDlc(lp.ProductTitle, enTitle)) item.dlc = 1;
    items.push(item);
  }
  console.log(`掲載 ${items.length} 件 / 除外 ${dropped} 件`);
  if (items.length < 100) throw new Error('掲載件数が異常に少ないため中断します（ページを守るための安全装置）');

  // 実績データを各アイテムへ付与
  let taCount = 0;
  for (const it of items) {
    const x = extras[it.id];
    if (x) { it.x = x; taCount++; }
  }
  console.log(`実績データ付与 ${taCount} 件`);

  // 過去最安データ（deku-extras.json があればマージする）
  let dekuExtras = {};
  try { dekuExtras = JSON.parse(readFileSync(join(ROOT, 'deku-extras.json'), 'utf8')); } catch { dekuExtras = {}; }
  let dekuCount = 0;
  for (const it of items) {
    const low = dekuExtras[it.id];
    if (low) { it.dlow = low; dekuCount++; }
  }
  console.log(`過去最安データ付与 ${dekuCount} 件`);
  console.log(`Game Pass付与 ${items.filter((it) => it.gp).length} 件 / DLC単品推定 ${items.filter((it) => it.dlc).length} 件`);

  // ---- USストア分（en-us のセール一覧 → market=US で価格取得。失敗したら前回分を維持） ----
  let usItems = null;
  let usCov = null;
  try {
    const us = await fetchDealsIds(DEALS_URL_US);
    console.log(`US: 対象 ${us.total} 件 / ID取得 ${us.ids.length} 件`);
    const usCat = await fetchCatalog(us.ids, 'en-US', 'US');
    const usGp = await fetchGamePassIds('US', 'en-us');
    console.log(`US: Game Pass収録リスト ${usGp.size} 件`);
    const built = [];
    let usDropped = 0;
    for (const id of us.ids) {
      const p = usCat.get(id);
      const lp = p?.LocalizedProperties?.[0];
      const picked = p ? pickPriceAndDates(p, 'USD') : null;
      if (!p || !lp || !picked) { usDropped++; continue; }
      const price = picked.price.ListPrice;
      const msrp = picked.price.MSRP;
      const pct = Math.round((1 - price / msrp) * 100);
      if (pct <= 0) { usDropped++; continue; }
      const title = lp.ProductTitle;
      const item = {
        id,
        t: title,
        en: title,
        pub: lp.PublisherName || '',
        p: price,
        m: msrp,
        pct,
        end: picked.cond.EndDate,
        url: `https://www.xbox.com/en-US/games/store/${slugify(title)}/${id}`,
        start: picked.cond.StartDate,
      };
      const img = NO_COVER.has(id) ? null : pickImage(lp);
      if (img) item.img = img;
      if (usGp.has(id)) item.gp = 1;
      if (isStandaloneDlc(title, title)) item.dlc = 1;
      const x = extras[id];
      if (x) item.x = x;
      built.push(item);
    }
    console.log(`US: 掲載 ${built.length} 件 / 除外 ${usDropped} 件`);
    if (built.length >= 100) { usItems = built; usCov = [us.total, usDropped, built.length]; }
    else console.log('US: 掲載件数が異常に少ないため前回分を維持します');
  } catch (e) {
    console.log(`USストア取得に失敗（前回分を維持）: ${e.message}`);
  }

  const prevSet = new Set(oldIds);
  const newCount = items.filter((it) => !prevSet.has(it.id)).length;
  console.log(`新着 ${newCount} 件`);

  // ---- 価格履歴の記録 ----
  // { id: [[yyyy-mm-dd, price], ...] }。初出はセール開始日（60日以内なら）を、その後は価格が変わった日だけ点を打つ
  let hist = {};
  try { hist = JSON.parse(readFileSync(join(ROOT, 'price-history.json'), 'utf8')); } catch { hist = {}; }
  const today = jstDateOf(new Date());
  let histNew = 0, histChanged = 0;
  for (const it of items) {
    const pts = hist[it.id];
    if (!Array.isArray(pts) || !pts.length) {
      let seed = today;
      if (it.start) {
        const sd = jstDateOf(new Date(it.start));
        const days = Math.round((new Date(today) - new Date(sd)) / 86400000);
        if (days >= 0 && days <= 60) seed = sd;
      }
      hist[it.id] = [[seed, it.p]];
      histNew++;
    } else if (pts[pts.length - 1][1] !== it.p) {
      pts.push([today, it.p]);
      histChanged++;
    }
  }
  writeFileSync(join(ROOT, 'price-history.json'), JSON.stringify(hist));
  console.log(`価格履歴: 新規 ${histNew} 件 / 価格変更 ${histChanged} 件 / 累計 ${Object.keys(hist).length} 件`);

  // PREV_IDS ← 差し替え前の ITEMS のID一覧
  const prevSpan = extractArray(html, 'var PREV_IDS =');
  html = html.slice(0, prevSpan.open) + JSON.stringify(oldIds) + html.slice(prevSpan.close + 1);
  // ITEMS 差し替え（PREV 差し替えで位置がずれるため再取得）
  const span2 = extractArray(html, 'var ITEMS =');
  html = html.slice(0, span2.open) + JSON.stringify(items) + html.slice(span2.close + 1);
  // ITEMS_US 差し替え（取得できなかった回は前回分をそのまま埋め戻す）
  const spanUs = extractArray(html, 'var ITEMS_US =');
  html = html.slice(0, spanUs.open) + JSON.stringify(usItems ?? oldUsItems) + html.slice(spanUs.close + 1);
  html = html.replace(/var US_COV = \[[\d,\s]*\];/, () => 'var US_COV = [' + (usCov ?? oldUsCov).join(', ') + '];');

  // 新着メモの「前回リスト」表記 ← いま差し替えた版の日時と件数（タイムスタンプ一括置換より先に退避）
  html = html.replace(/(<span id="prevTs">)[^<]*(<\/span>)/, `$1@@OLDTS@@$2`);
  html = html.replace(/(<span id="prevCount">)[^<]*(<\/span>)/, `$1${fmtNum(oldItems.length)}$2`);
  // データ日時の一括更新
  const newTs = nowJstLabel();
  html = html.split(oldTs).join(newTs);
  html = html.split('@@OLDTS@@').join(oldTs);

  // 出典表記と件数メモ
  const setSpan = (id, value) => { html = html.replace(new RegExp(`(<span id="${id}">)[^<]*(</span>)`), `$1${value}$2`); };
  setSpan('srcName', '');
  setSpan('srcRef', 'Microsoft Store 公式セールページ');
  setSpan('covTotal', fmtNum(total));
  setSpan('covDropped', fmtNum(dropped));
  setSpan('covKept', fmtNum(items.length));
  setSpan('taCov', fmtNum(taCount));
  html = html.replace(/<a id="srcLink" href="[^"]*"([^>]*)>[^<]*<\/a>/,
    `<a id="srcLink" href="${DEALS_URL}"$1>Microsoft Store 公式セールページ</a>`);

  // 価格履歴の埋め込み（現在の掲載分のみ）とスナップショット日
  const histEmbed = {};
  for (const it of items) if (hist[it.id]) histEmbed[it.id] = hist[it.id];
  html = html.replace(/var HIST = \{[^}]*\};/, () => 'var HIST = ' + JSON.stringify(histEmbed) + ';');
  html = html.replace(/var SNAP_DATE = "[^"]*";/, () => `var SNAP_DATE = "${today}";`);

  writeFileSync(INDEX, html);
  console.log(`更新完了: ${newTs} 時点 / 掲載 ${items.length} 件 / 新着 ${newCount} 件`);
}

main().catch((e) => { console.error('更新失敗:', e); process.exit(1); });
