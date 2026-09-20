// build-static-desktop.js
// 在你自己的專案資料夾裡執行一次： node build-static-desktop.js
// 需要跟 server.js 放在同一層（同一個 .env、同一個 package.json/node_modules）
//
// 這支腳本會：
//   1. 直接呼叫 Notion API 抓最新行程資料 + Information 資料庫內容（跟 Railway 完全無關）
//   2. 把資料寫死進 desktop-static-template.html
//   3. 輸出成 egypt-itinerary-static.html —— 之後開這個檔案零網路請求
//
// 之後 Notion 有更新，想同步的話，重新執行一次這支腳本、覆蓋舊檔案即可。

require('dotenv').config();
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID      = process.env.NOTION_DATABASE_ID;
const INFO_DB_ID = '2ec81baf2aca80c3b7a3c2aca0803e9a'; // 跟 server.js 相同

// Day 0 的實際日曆日期（用來判斷某個時間是否跨過午夜到隔天）
const BASE_DATE_STR = '2026-10-07';
function ymdInTaipei(date){
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // → YYYY-MM-DD
}
function nominalDateStrForDay(dayNum){
  const d = new Date(BASE_DATE_STR + 'T00:00:00+08:00');
  d.setDate(d.getDate() + dayNum);
  return ymdInTaipei(d);
}

// ── 與 server.js 相同的 tag 設定 ──────────────────────────────────────────
const TAG_CONFIG = {
  'Commute':       { icon: 'ti-car',              color: '#E8EAE6', textColor: '#4A5E52' },
  'Flight':        { icon: 'ti-plane',            color: '#D6E8F0', textColor: '#2A6A8A' },
  'Temple':        { icon: 'ti-building-arch',    color: '#E8E5FC', textColor: '#4A42A8' },
  'Pyramids Tomb': { icon: 'ti-pyramid',          color: '#F5DDD3', textColor: '#8A3518' },
  'Pyramids & Tombs': { icon: 'ti-pyramid',       color: '#F5DDD3', textColor: '#8A3518' },
  'Stay':          { icon: 'ti-bed',              color: '#D4EDE4', textColor: '#0F6E56' },
  'Museum':        { icon: 'ti-building-bank',    color: '#EAE8F5', textColor: '#4A42A8' },
  'Sightseeing':   { icon: 'ti-binoculars',       color: '#FAE8C4', textColor: '#A06A10' },
  'Local Village': { icon: 'ti-home-2',           color: '#D8EDE4', textColor: '#2D6B50' },
  'Market':        { icon: 'ti-shopping-bag',     color: '#F5E8D4', textColor: '#8A5A20' },
  'Shopping':      { icon: 'ti-hanger',           color: '#F5E8D4', textColor: '#8A5A20' },
  'church':        { icon: 'ti-building-church',  color: '#F0DDD8', textColor: '#8A3518' },
  'Meal':          { icon: 'ti-tools-kitchen-2',  color: '#F0E8D4', textColor: '#8A6020' },
  'Coffee Shop':   { icon: 'ti-coffee',           color: '#EDE0D4', textColor: '#6B3E1E' },
  'default':       { icon: 'ti-map-pin',          color: '#E8E4DE', textColor: '#6B6054' },
};

// ── 與 server.js 完全相同的解析邏輯 ────────────────────────────────────────
function parsePage(page) {
  const props = page.properties;
  const titleParts = props.Activity?.title || [];
  const title = titleParts.map(t => t.plain_text).join('').trim();

  const daySelect = props.Day?.select?.name || '';
  const dayMatch  = daySelect.match(/Day\s*(\d+)/i);
  const dayNum    = dayMatch ? parseInt(dayMatch[1]) : 0;

  const dateObj  = props.Date?.date;
  const startRaw = dateObj?.start || null;
  const endRaw   = dateObj?.end   || null;

  let timeStart = null, timeEnd = null, dateOnly = false;
  if (startRaw) {
    if (startRaw.includes('T')) {
      const d = new Date(startRaw);
      timeStart = d.toLocaleTimeString('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei'
      });
    } else {
      dateOnly = true;
    }
    if (endRaw && endRaw.includes('T')) {
      const d = new Date(endRaw);
      timeEnd = d.toLocaleTimeString('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei'
      });
    }
  }

  const tags       = (props.Tag?.multi_select || []).map(t => t.name);
  const primaryTag = tags[0] || 'default';
  const tagConfig  = TAG_CONFIG[primaryTag] || TAG_CONFIG['default'];

  const highlights = (props[' Highlights']?.rich_text || [])
    .map(t => t.plain_text).join('').trim();
  const era = (props.Era?.rich_text || []).map(t => t.plain_text).join('').trim();
  const mapUrl = props.Map?.url || null;

  // 跨午夜修正：時間實際落在隔天，但仍屬於這個 Day 分組時（例如深夜起飛），
  // 排序/顯示都把小時 +24（00:30 → 24:30），這樣它會正確排在同一天其他項目之後。
  if (timeStart && startRaw) {
    const actualDateStr = ymdInTaipei(new Date(startRaw));
    const nominalStr = nominalDateStrForDay(dayNum);
    if (actualDateStr > nominalStr) {
      const [hh, mm] = timeStart.split(':').map(Number);
      timeStart = String(hh + 24).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }
  }

  const rhythm = (props.Rhythm?.rich_text || [])
    .map(t => t.plain_text).join('').trim();

  const summary = (props.Summary?.rich_text || [])
    .map(t => t.plain_text).join('').trim();
  const titleEN = (props['Title EN']?.rich_text || [])
    .map(t => t.plain_text).join('').trim();

  // 封面圖：優先抓「cover」欄位（Files & media 屬性），沒有的話退而抓 Notion 頁面本身的封面
  let coverUrl = null;
  const coverFiles = props.cover?.files || [];
  if (coverFiles.length > 0 && coverFiles[0].file?.url) {
    coverUrl = coverFiles[0].file.url;
  } else if (page.cover?.external?.url) {
    coverUrl = page.cover.external.url;
  } else if (page.cover?.file?.url) {
    coverUrl = page.cover.file.url;
  }

  return {
    id: page.id, title, dayNum, dayLabel: daySelect,
    timeStart, timeEnd, dateOnly, hasTime: !!timeStart,
    tags, primaryTag, tagConfig, highlights, era,
    mapUrl, notionUrl: page.url,
    rhythm, summary, titleEN, coverUrl,
  };
}

function parseInfoPage(page) {
  const props = page.properties;
  const title = (props.Name?.title || props.Title?.title || [])
    .map(t => t.plain_text).join('').trim();
  const category = props['Multi-select']?.select?.name || '';
  const summary = (props.Summary?.rich_text || [])
    .map(t => t.plain_text).join('').trim();
  const order = props.Order?.number ?? 9999;

  return {
    id: page.id, title, category, summary, order,
    notionUrl: page.url,
    emoji: page.icon?.emoji || null,
  };
}

// ── 與 server.js 完全相同的 blocks → text 解析 ─────────────────────────────
function blocksToText(blocks, childMap = {}) {
  const lines = [];
  for (const block of blocks) {
    const type = block.type;
    const content = block[type];
    if (!content) continue;

    const richText = content.rich_text || content.text || [];
    const text = Array.isArray(richText)
      ? richText.map(t => t.plain_text || '').join('').trim()
      : '';

    if (type === 'heading_1')               { if (text) lines.push('# ' + text); }
    else if (type === 'heading_2')          { if (text) lines.push('## ' + text); }
    else if (type === 'heading_3')          { if (text) lines.push('### ' + text); }
    else if (type === 'bulleted_list_item') { if (text) lines.push('• ' + text); }
    else if (type === 'numbered_list_item') { if (text) lines.push('· ' + text); }
    else if (type === 'paragraph')          { if (text) lines.push(text); }
    else if (type === 'quote')              { if (text) lines.push('❝ ' + text); }
    else if (type === 'callout') {
      const icon = block.callout?.icon?.emoji || '';
      if (text) lines.push((icon ? icon + ' ' : '') + text);
    }
    else if (type === 'toggle')             { if (text) lines.push('▸ ' + text); }
    else if (type === 'divider')            { lines.push('---'); }
    else if (type === 'bookmark') {
      const url     = content.url || '';
      const caption = (content.caption || []).map(t => t.plain_text || '').join('').trim();
      if (url) lines.push('🔗 ' + (caption || url) + '\n' + url);
    }
    else if (type === 'image') {
      const url     = content.external?.url || content.file?.url || '';
      const caption = (content.caption || []).map(t => t.plain_text || '').join('').trim();
      if (url) lines.push('🖼 ' + (caption || '圖片') + '\n' + url);
    }
    else if (type === 'link_preview' || type === 'embed') {
      const url = content.url || '';
      if (url) lines.push('🔗 ' + url);
    }
    else if (type === 'table') {
      const rowBlocks = childMap[block.id] || [];
      if (rowBlocks.length) {
        rowBlocks.forEach((row, i) => {
          const cells = (row.table_row?.cells || []).map(cell =>
            cell.map(t => t.plain_text || '').join('').trim()
          );
          if (cells.length) {
            lines.push('| ' + cells.join(' | ') + ' |');
            if (i === 0) lines.push('|' + cells.map(() => '---|').join(''));
          }
        });
      }
    }
    else if (type === 'table_row') { /* handled via table above */ }
    else if (text) { lines.push(text); }
  }
  return lines.join('\n');
}

async function getAllPages(dbId, sorts = []) {
  let results = [], cursor;
  do {
    const response = await notion.databases.query({
      database_id: dbId,
      sorts,
      start_cursor: cursor,
      page_size: 100,
    });
    results = results.concat(response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

function groupByDay(pages) {
  const days = {};
  for (const page of pages) {
    const p = parsePage(page);
    if (!days[p.dayNum]) days[p.dayNum] = [];
    days[p.dayNum].push(p);
  }
  for (const day of Object.values(days)) {
    day.sort((a, b) => {
      if (!a.timeStart) return 1;
      if (!b.timeStart) return -1;
      return a.timeStart.localeCompare(b.timeStart);
    });
  }
  return days;
}

// ── 抓單一 Information 頁面的完整內文（含表格） ─────────────────────────────
async function fetchInfoContent(pageId) {
  const blocksRes = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  const tableBlocks = blocksRes.results.filter(b => b.type === 'table');
  const childMap = {};
  await Promise.all(tableBlocks.map(async tb => {
    try {
      const rows = await notion.blocks.children.list({ block_id: tb.id, page_size: 100 });
      childMap[tb.id] = rows.results;
    } catch (e) { /* skip */ }
  }));
  return blocksToText(blocksRes.results, childMap);
}

// ── 把 Notion 給的一小時效期圖片網址，當下就下載成 base64 直接嵌進 HTML ──────
// Notion 官方文件：檔案網址效期只有 1 小時（https://developers.notion.com/docs/retrieving-files）。
// 這一步一定要在拿到資料後「立刻」做，嵌進去的是圖片本身的內容，之後永遠不會失效。
async function embedCovers(grouped) {
  const allItems = Object.values(grouped).flat();
  const withCover = allItems.filter(it => it.coverUrl);
  console.log(`🖼  正在下載 ${withCover.length} 張封面圖並嵌入（僅此時效期還有效）…`);

  await Promise.all(withCover.map(async (it) => {
    try {
      const res = await fetch(it.coverUrl);
      if (!res.ok) { it.coverUrl = null; return; }
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      it.coverUrl = `data:${contentType};base64,${buf.toString('base64')}`;
    } catch (e) {
      it.coverUrl = null; // 下載失敗就跳過這張圖，其餘文字資料不受影響
    }
  }));
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.NOTION_TOKEN || !DB_ID) {
    console.error('❌ 缺少 NOTION_TOKEN 或 NOTION_DATABASE_ID，請確認 .env 存在且與這支腳本同一層');
    process.exit(1);
  }

  console.log('📡 正在從 Notion 抓取行程資料…');
  const pages = await getAllPages(DB_ID, [{ property: 'Date', direction: 'ascending' }]);
  const grouped = groupByDay(pages);
  console.log(`✅ 行程項目：${pages.length} 筆`);

  await embedCovers(grouped);

  console.log('📡 正在從 Notion 抓取 Information 資料…');
  const infoPages = await getAllPages(INFO_DB_ID, [{ property: 'Order', direction: 'ascending' }]);
  const infoItems = [];
  for (const page of infoPages) {
    const info = parseInfoPage(page);
    const content = await fetchInfoContent(page.id);
    infoItems.push({ ...info, content });
  }
  console.log(`✅ Information 項目：${infoItems.length} 筆`);

  const infoGrouped = {};
  infoItems.forEach(it => {
    const cat = it.category || '其他';
    if (!infoGrouped[cat]) infoGrouped[cat] = [];
    infoGrouped[cat].push(it);
  });

  const templatePath = path.join(__dirname, 'desktop-static-template.html');
  if (!fs.existsSync(templatePath)) {
    console.error('❌ 找不到 desktop-static-template.html，請確認它與這支腳本放在同一層資料夾');
    process.exit(1);
  }
  let html = fs.readFileSync(templatePath, 'utf-8');

  const generatedAt = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  html = html.replace('/*__DATA__*/{}/*__END_DATA__*/', JSON.stringify(grouped));
  html = html.replace('/*__INFO_DATA__*/{}/*__END_INFO_DATA__*/', JSON.stringify(infoGrouped));
  html = html.split('__GENERATED_AT__').join(generatedAt);

  const outPath = path.join(__dirname, 'egypt-itinerary-static.html');
  fs.writeFileSync(outPath, html, 'utf-8');

  console.log('✅ 靜態版已產生：' + outPath);
  console.log('   快照時間：' + generatedAt);
  console.log('   這個檔案之後可以直接雙擊開啟，或放到任何地方，不需要 server.js 或 Railway 在線。');
}

main().catch(err => {
  console.error('❌ 產生失敗：', err.message);
  process.exit(1);
});
