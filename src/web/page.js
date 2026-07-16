// Self-contained single-page frontend served for every non-API route.
// Styled after the OpenAI "Research" index: top nav, big title, category
// tabs, and an editorial list of entries. Clicking an entry opens an
// article view with the rendered markdown (+ inline edit / delete).
import { createTranslator, MESSAGES, normalizeLocale } from '../i18n.js';

export function renderPage(locale = 'zh-CN') {
  const normalized = normalizeLocale(locale);
  const t = createTranslator(normalized);
  const clientMessages = JSON.stringify(MESSAGES[normalized]).replace(/</g, '\\u003c');

  return /* html */ `<!DOCTYPE html>
<html lang="${normalized}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wikinest</title>
<script>
  // 桌面端(Electron)会带上 ?desktop=1。尽早在 <head> 里同步打标记,
  // 让下面的 .desktop 样式在首次绘制前生效,避免为窗口按钮腾位时的布局跳动。
  if (new URLSearchParams(location.search).has('desktop')) {
    document.documentElement.classList.add('desktop');
  }
</script>
<link rel="stylesheet" href="/vendor/highlight.js/github.min.css" />
<style>
  :root {
    --bg: #ffffff;
    --fg: #0d0d0d;            /* near-black ink */
    --muted: #6e6e73;         /* secondary text */
    --faint: #ececec;         /* hairline separators */
    --hover: #f5f5f5;
    --chip: #f0f0f0;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
            "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    --mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --maxw: 1080px;
    --side-w: 244px;          /* sidebar width when shown (Craft-style show/hide) */
    /* One shared duration + easing for the whole sidebar open/close motion so
       the width, the pushed-over content and the chevron all move in lockstep.
       The curve is a smooth "decelerate" (iOS-like) so it feels quick + settled. */
    --side-dur: .24s;
    --side-ease: cubic-bezier(.33, .9, .25, 1);
    --titlebar: 44px;         /* desktop: traffic lights + sidebar toggle */
  }
  * { box-sizing: border-box; scrollbar-width: none; }
  html, body { margin: 0; height: 100%; overflow-x: hidden; }
  body {
    font-family: var(--sans); color: var(--fg); background: var(--bg);
    font-size: 15px; -webkit-font-smoothing: antialiased;
    padding-left: 0;   /* sidebar hidden reserves no space */
    transition: padding-left var(--side-dur) var(--side-ease);
  }
  body.sidebar-open { padding-left: var(--side-w); }  /* sidebar shown */
  a { color: inherit; text-decoration: none; }
  button {
    font-family: inherit; cursor: pointer; border: none; background: none;
    color: var(--fg); font-size: 14px;
  }

  /* ---------- Top nav ---------- */
  #nav {
    position: sticky; top: 0; z-index: 20; background: rgba(255,255,255,.97);
    border-bottom: 1px solid var(--faint);
  }
  .nav-inner {
    max-width: var(--maxw); margin: 0 auto; padding: 16px 24px;
    display: flex; align-items: center; gap: 26px;
  }
  .nav-collapse {
    width: 34px; height: 34px; border: 1px solid var(--faint); border-radius: 9px;
    display: grid; place-items: center; flex: 0 0 auto;
    color: var(--muted); background: #fff;
    transition: color .12s, background .12s, border-color .12s;
    -webkit-app-region: no-drag;
  }
  .nav-collapse:hover { color: var(--fg); background: var(--hover); border-color: #d8d8d8; }
  .nav-collapse svg {
    width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .desktop-titlebar {
    display: none; position: fixed; top: 0; left: 0; right: 0; height: var(--titlebar);
    z-index: 50; align-items: center; padding-left: 78px;
    background: rgba(255,255,255,.97); -webkit-app-region: drag;
  }
  .desktop-titlebar .nav-collapse {
    width: 32px; height: 32px; border-color: transparent; background: transparent;
    -webkit-app-region: no-drag;
  }
  /* Unified search / ask command bar (the single recall entry). */
  .cmdbar {
    flex: 1; display: flex; align-items: center; gap: 9px;
    background: var(--chip); border: 1px solid transparent; border-radius: 11px;
    padding: 9px 12px; transition: border-color .15s, background .15s, box-shadow .15s;
  }
  .cmdbar:focus-within { background: #fff; border-color: #d4d4d4; box-shadow: 0 4px 16px rgba(0,0,0,.05); }
  .cmd-ic { width: 17px; height: 17px; flex-shrink: 0; fill: none; stroke: var(--muted);
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .cmdbar input {
    flex: 1; border: none; outline: none; background: none; font-family: inherit;
    font-size: 14.5px; color: var(--fg); min-width: 0;
  }
  .cmdbar input::placeholder { color: var(--muted); }
  .cmd-kbd {
    flex-shrink: 0; font-family: inherit; font-size: 11.5px; color: var(--muted);
    background: #fff; border: 1px solid var(--faint); border-radius: 6px; padding: 2px 7px;
  }
  .nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .icon-btn {
    width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
    font-size: 15px; color: var(--fg); transition: background .12s;
  }
  .icon-btn:hover { background: var(--hover); }
  .btn-primary {
    background: var(--fg); color: #fff; border-radius: 999px; padding: 8px 16px;
    font-size: 13.5px; font-weight: 500; transition: opacity .12s;
  }
  .btn-primary:hover { opacity: .85; }

  /* ---------- Left icon rail (hover to expand) ---------- */
  #sidebar {
    position: fixed; top: 0; left: 0; bottom: 0; width: var(--side-w);
    background: #fff; border-right: 1px solid var(--faint); z-index: 30;
    display: flex; flex-direction: column; padding: 10px 0 12px;
    overflow: hidden; will-change: transform;
    transition: transform var(--side-dur) var(--side-ease);
  }
  /* Craft-style: the panel slides fully off-screen when hidden; the toolbar
     toggle remains in normal layout and brings it back. */
  body:not(.sidebar-open) #sidebar { transform: translateX(-100%); }

  .side-brand {
    display: flex; align-items: center; gap: 11px; height: 45px;
    padding: 0 19px; margin-bottom: 8px; flex-shrink: 0; color: var(--fg); cursor: pointer;
  }
  .side-brand .mark { flex-shrink: 0; display: grid; place-items: center; }
  .side-brand .brand-logo { width: 24px; height: 24px; display: block; border-radius: 6px; }
  .side-brand .side-label { font-weight: 650; font-size: 15px; letter-spacing: -0.01em; }
  .side-nav { display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
  .side-item {
    display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
    padding: 9px 11px; border-radius: 9px; color: var(--muted); white-space: nowrap;
    transition: background .12s, color .12s;
  }
  .side-item .ic { width: 22px; height: 22px; flex-shrink: 0; display: grid; place-items: center; }
  .side-item .ic svg {
    width: 19px; height: 19px; fill: none; stroke: currentColor;
    stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round;
  }
  .side-item:hover { background: var(--hover); color: var(--fg); }
  .side-item.active { background: var(--chip); color: var(--fg); font-weight: 500; }
  .side-count {
    margin-left: auto; font-size: 12px; color: var(--muted);
    background: var(--chip); border-radius: 999px; padding: 1px 8px; min-width: 22px; text-align: center;
  }
  /* The panel is either fully shown or fully hidden now, so labels/counts are
     simply always visible while it's on screen (no rail-collapse fade needed). */

  /* Category section (only meaningful when expanded, so hidden while collapsed) */
  .side-sec { padding: 14px 8px 2px; overflow: hidden; }
  .side-sec-label {
    font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted);
    padding: 0 11px 7px; white-space: nowrap;
  }
  .side-cats { display: flex; flex-direction: column; gap: 2px; }
  .cat-dot {
    width: 7px; height: 7px; border-radius: 50%; background: #c2c2c7; flex-shrink: 0;
    margin: 0 8px 0 7px;
  }
  .side-item.active .cat-dot { background: var(--fg); }

  /* Persistent desktop actions at the bottom of the sidebar. */
  .side-foot {
    margin: auto 8px 4px; display: flex; flex-direction: column; align-items: stretch; gap: 2px;
  }
  .mcp-mini, .side-settings {
    width: 100%; min-height: 38px; padding: 8px 11px; border: 0; border-radius: 9px;
    align-items: center; gap: 11px; color: var(--muted); background: transparent;
    text-align: left; white-space: nowrap; transition: color .12s, background .12s;
  }
  .mcp-mini { display: none; cursor: pointer; }
  html.desktop .mcp-mini { display: flex; }
  .mcp-mini:hover, .side-settings:hover { color: var(--fg); background: var(--hover); }
  .mcp-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0;
    box-shadow: 0 0 0 3px rgba(34,197,94,.16);
  }
  .mcp-text {
    font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .side-settings { display: none; }
  .side-settings.desktop-visible { display: flex; }
  .side-settings svg {
    width: 18px; height: 18px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.8;
    stroke-linecap: round; stroke-linejoin: round;
  }

  /* ---------- Settings modal (in-page, desktop) ---------- */
  .set-overlay {
    position: fixed; inset: 0; z-index: 100; display: none;
    align-items: flex-start; justify-content: center;
    background: rgba(0,0,0,.36); backdrop-filter: blur(3px);
    padding: 48px 20px; overflow: auto;
  }
  .set-overlay.show { display: flex; }
  .set-modal {
    width: 100%; max-width: 620px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--faint); border-radius: 16px;
    box-shadow: 0 24px 80px rgba(0,0,0,.24); overflow: hidden;
    display: flex; flex-direction: column; max-height: calc(100vh - 96px);
  }
  .set-head {
    display: flex; align-items: baseline; gap: 10px; padding: 22px 24px 6px; flex-shrink: 0;
  }
  .set-head h2 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .set-head .set-lead { color: var(--muted); font-size: 13px; }
  .set-body { padding: 8px 24px 4px; overflow: auto; }
  .set-group { border: 1px solid var(--faint); border-radius: 12px; padding: 4px 16px 14px; margin: 14px 0; }
  .set-group > .set-legend {
    font-size: 13px; font-weight: 600; color: var(--fg); padding-top: 14px;
  }
  .set-group > .set-note { font-size: 12px; color: var(--muted); margin: 4px 0 12px; }
  .set-field { margin-bottom: 12px; }
  .set-field:last-child { margin-bottom: 4px; }
  .set-field label { display: block; font-size: 12.5px; font-weight: 500; margin-bottom: 5px; }
  .set-field input, .set-field select {
    width: 100%; padding: 9px 11px; border: 1px solid var(--faint); border-radius: 9px;
    font-family: inherit; font-size: 13.5px; color: var(--fg); background: #fff; outline: none;
    transition: border-color .12s, box-shadow .12s;
  }
  .set-field input:focus, .set-field select:focus { border-color: #c4c4c4; box-shadow: 0 0 0 3px rgba(0,0,0,.05); }
  .set-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .set-vault { display: flex; align-items: center; gap: 10px; }
  .set-vault code {
    flex: 1; font-family: var(--mono); font-size: 12px; color: var(--muted);
    background: var(--chip); border-radius: 8px; padding: 8px 10px; overflow-wrap: anywhere;
  }
  .set-foot {
    display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    padding: 14px 24px; border-top: 1px solid var(--faint); background: var(--bg);
  }
  .set-foot .set-status { font-size: 12.5px; color: var(--muted); }
  .set-foot .spacer { flex: 1; }
  .set-btn {
    font-family: inherit; font-size: 13.5px; padding: 8px 18px; border-radius: 999px;
    border: 1px solid var(--faint); background: #fff; color: var(--fg); transition: background .12s, opacity .12s;
  }
  .set-btn:hover { background: var(--hover); }
  .set-btn.primary { background: var(--fg); color: #fff; border-color: var(--fg); }
  .set-btn.primary:hover { background: var(--fg); opacity: .85; }
  .mcp-status {
    display: flex; align-items: center; gap: 9px; padding: 12px 14px;
    border-radius: 10px; background: #f2faf4; color: #24743a; font-size: 13.5px; font-weight: 500;
  }
  .mcp-status .mcp-dot { box-shadow: none; }
  .mcp-copy-row { display: flex; align-items: stretch; gap: 10px; }
  .mcp-code {
    flex: 1; min-width: 0; margin: 0; padding: 11px 12px; border: 1px solid var(--faint);
    border-radius: 9px; background: var(--chip); color: var(--fg); font: 12px/1.6 var(--mono);
    white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
  }
  .mcp-copy-row .set-btn { align-self: center; flex-shrink: 0; }
  @media (max-width: 560px) { .set-grid2 { grid-template-columns: 1fr; } }

  .container { max-width: var(--maxw); margin: 0 auto; padding: 0 24px; }

  /* ---------- Index view ---------- */
  .index-head { display: flex; align-items: baseline; gap: 12px; margin: 40px 0 22px; }
  .page-title {
    font-size: 34px; font-weight: 500; letter-spacing: -0.02em; margin: 0;
  }
  .idx-count { font-size: 15px; color: var(--muted); }
  .page-sub { color: var(--muted); font-size: 16px; margin: 0 0 26px; }
  .cur-filter { font-size: 15px; font-weight: 500; color: var(--fg); }
  .controls {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--faint); padding-bottom: 14px; gap: 16px;
    flex-wrap: wrap;
  }
  .control-right { display: flex; align-items: center; gap: 14px; }
  .ghost {
    color: var(--muted); font-size: 14px; display: flex; align-items: center; gap: 5px;
    transition: color .12s;
  }
  .ghost:hover { color: var(--fg); }
  .view-toggle { display: flex; gap: 2px; }
  .vt {
    width: 30px; height: 28px; border-radius: 6px; color: var(--muted);
    display: grid; place-items: center; font-size: 15px;
  }
  .vt.active { background: var(--chip); color: var(--fg); }

  .search-bar { padding-top: 16px; }
  .search-bar input {
    width: 100%; padding: 12px 14px; border: 1px solid var(--faint); border-radius: 10px;
    font-size: 15px; font-family: inherit; outline: none; transition: border-color .15s;
  }
  .search-bar input:focus { border-color: #c7c7c7; }

  /* list layout */
  .list.as-list .row {
    display: grid; grid-template-columns: 150px 1fr; gap: 24px;
    padding: 26px 0; border-bottom: 1px solid var(--faint); cursor: pointer;
  }
  .list.as-list .row:hover .row-title { text-decoration: underline; }
  .row-meta { display: flex; flex-direction: column; gap: 6px; }
  .row-cat { font-size: 13.5px; color: var(--fg); }
  .row-date { font-size: 13.5px; color: var(--muted); }
  .row-title { font-size: 21px; font-weight: 500; letter-spacing: -0.01em; line-height: 1.3; }
  .row-badge {
    display: inline-block; vertical-align: middle; margin-right: 9px; transform: translateY(-2px);
    font-size: 11.5px; font-weight: 500; letter-spacing: .02em; color: #6a5acd;
    background: #efecfb; border-radius: 6px; padding: 2px 7px;
  }
  .row-desc {
    margin-top: 8px; color: var(--muted); font-size: 15px; line-height: 1.55;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* grid layout */
  .list.as-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 22px; padding-top: 28px;
  }
  .list.as-grid .row {
    border: 1px solid var(--faint); border-radius: 14px; padding: 20px 20px 22px;
    cursor: pointer; transition: border-color .12s, box-shadow .12s;
    display: flex; flex-direction: column; gap: 10px;
  }
  .list.as-grid .row:hover { border-color: #d0d0d0; box-shadow: 0 6px 20px rgba(0,0,0,.05); }
  .list.as-grid .row-meta { flex-direction: row; gap: 10px; align-items: center; }
  .list.as-grid .row-title { font-size: 18px; }
  .list.as-grid .row-desc { -webkit-line-clamp: 3; }

  .empty { color: var(--muted); padding: 60px 0; text-align: center; font-size: 15px; }

  /* ---------- multi-select → synthesize one article ---------- */
  .ghost.select-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .ghost.select-btn.active { color: var(--fg); }
  .list.selecting .row { position: relative; padding-left: 34px; cursor: pointer; }
  .list.selecting.as-grid .row { padding-left: 20px; }
  .list.selecting .row:hover .row-title { text-decoration: none; }
  .row-check {
    position: absolute; left: 2px; top: 27px; width: 19px; height: 19px;
    border: 1.6px solid #c7c7cc; border-radius: 5px; display: grid; place-items: center;
    background: #fff; transition: background .12s, border-color .12s;
  }
  .list.as-grid .row-check { left: auto; right: 16px; top: 16px; }
  .row-check svg { width: 12px; height: 12px; fill: none; stroke: #fff; stroke-width: 3;
    stroke-linecap: round; stroke-linejoin: round; opacity: 0; transition: opacity .1s; }
  .row.sel .row-check { background: var(--fg); border-color: var(--fg); }
  .row.sel .row-check svg { opacity: 1; }
  .list.selecting .row.nosel { opacity: .5; cursor: not-allowed; }
  .list.selecting .row.nosel .row-check { border-style: dashed; background: var(--hover); }

  .selection-bar {
    position: fixed; bottom: 26px; left: 50%; transform: translate(-50%, 24px);
    background: var(--fg); color: #fff; border-radius: 999px; z-index: 60;
    padding: 9px 10px 9px 20px; display: flex; align-items: center; gap: 14px;
    box-shadow: 0 12px 44px rgba(0,0,0,.28); opacity: 0; pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .selection-bar.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .selection-bar .sb-count { font-size: 14px; white-space: nowrap; }
  .selection-bar .sb-count b { font-weight: 600; }
  .selection-bar button { color: #fff; font-size: 13.5px; }
  .selection-bar .sb-cancel { opacity: .65; }
  .selection-bar .sb-cancel:hover { opacity: 1; }
  .selection-bar .sb-go {
    background: #fff; color: var(--fg); border-radius: 999px; padding: 8px 17px;
    font-weight: 500; transition: opacity .12s;
  }
  .selection-bar .sb-go:hover { opacity: .85; }
  .selection-bar .sb-go:disabled { opacity: .4; cursor: default; }

  /* ---------- Category digest banner ---------- */
  .digest-card {
    border: 1px solid var(--faint); border-radius: 14px; padding: 18px 22px; margin-top: 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    background: linear-gradient(180deg, #fafafa, #f4f4f5);
  }
  .digest-card .dc-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .digest-card .dc-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .digest-card .dc-sub { font-size: 13.5px; color: var(--muted); }
  .digest-card .dc-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .digest-card button {
    border: 1px solid var(--faint); border-radius: 999px; padding: 7px 15px; font-size: 13px;
    color: var(--muted); background: #fff; transition: background .12s, border-color .12s, color .12s;
  }
  .digest-card button:hover { background: var(--hover); border-color: #d6d6d6; color: var(--fg); }
  .digest-card .primary { background: var(--fg); color: #fff; border-color: var(--fg); }
  .digest-card .primary:hover { background: #000; color: #fff; }
  .digest-badge {
    display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--faint);
    border-radius: 999px; padding: 2px 10px; margin-bottom: 10px;
  }

  /* ---------- Ask (RAG) view ---------- */
  #askView { padding-bottom: 120px; }
  .ask-q { font-size: 26px; font-weight: 500; letter-spacing: -0.02em;
    margin: 44px 0 4px; line-height: 1.3; }
  .ask-q:empty { display: none; }
  .ask-result { margin-top: 20px; }
  .ask-loading { color: var(--muted); font-size: 15px; padding: 20px 2px; }
  /* Onboarding / empty state with example questions. */
  .ask-empty { padding: 20px 0; }
  .ask-empty .ee-title { font-size: 34px; font-weight: 500; letter-spacing: -0.02em; margin: 40px 0 8px; }
  .ask-empty .ee-sub { color: var(--muted); font-size: 16px; margin: 0 0 22px; }
  .ask-chips { display: flex; flex-wrap: wrap; gap: 10px; }
  .ask-chip {
    border: 1px solid var(--faint); border-radius: 999px; padding: 9px 15px;
    font-size: 14px; color: var(--fg); background: #fff; cursor: pointer;
    transition: border-color .12s, background .12s;
  }
  .ask-chip:hover { border-color: #cfcfcf; background: var(--hover); }
  .ask-answer { line-height: 1.8; font-size: 16.5px; }
  .ask-answer > :first-child { margin-top: 0; }
  .ask-answer h2 { font-size: 1.2em; font-weight: 600; margin: 1.4em 0 .5em; }
  .ask-answer a { text-decoration: underline; text-decoration-color: #c8c8c8; text-underline-offset: 2px; }
  .ask-answer a:hover { text-decoration-color: var(--fg); }
  .ask-answer code { background: var(--chip); padding: .15em .4em; border-radius: 4px;
    font-family: var(--mono); font-size: 85%; }
  .ask-answer pre { background: #f7f7f6; border: 1px solid var(--faint); padding: 14px 16px;
    border-radius: 10px; overflow-x: auto; }
  .ask-answer ul, .ask-answer ol { padding-left: 1.5em; }

  /* ---------- Article view ---------- */
  #articleView { padding-top: 18px; padding-bottom: 140px; }

  /* slim action bar */
  .article-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    margin-bottom: 20px;
  }
  .backBtn { color: var(--muted); font-size: 14px; }
  .backBtn:hover { color: var(--fg); }
  .article-actions { display: flex; gap: 8px; }
  .article-actions button {
    border: 1px solid var(--faint); border-radius: 999px; padding: 6px 15px; font-size: 13px;
    color: var(--muted); transition: background .12s, border-color .12s, color .12s;
  }
  .article-actions button:hover { background: var(--hover); border-color: #d6d6d6; color: var(--fg); }
  .article-actions .btn-primary { border-color: var(--fg); color: #fff; }
  .article-actions .btn-primary:hover { background: #000; color: #fff; opacity: 1; }

  /* centered hero header */
  .hero { text-align: center; max-width: 760px; margin: 40px auto 8px; }
  .hero-meta {
    display: flex; justify-content: center; align-items: center; gap: 8px;
    font-size: 13.5px; margin-bottom: 26px;
  }
  .hero-meta .date { color: var(--fg); }
  .hero-meta .cat { color: var(--muted); }
  .hero-meta .dot { color: var(--faint); }
  .hero-title {
    font-size: 56px; line-height: 1.08; font-weight: 500; letter-spacing: -0.035em;
    margin: 0 auto; max-width: 14em;
  }
  .hero-sub {
    margin: 22px auto 0; max-width: 34em; color: var(--muted);
    font-size: 19px; line-height: 1.5;
  }
  .cats { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 20px 0 0; }
  .cat-chip {
    display: inline-flex; align-items: center; gap: 6px; background: var(--chip);
    border-radius: 999px; padding: 5px 12px; font-size: 13px; color: var(--fg);
  }
  .cat-chip .name { cursor: pointer; }
  .cat-chip .name:hover { text-decoration: underline; }
  .cat-chip .x { color: var(--muted); cursor: pointer; font-size: 11px; line-height: 1; }
  .cat-chip .x:hover { color: #d00; }
  .cat-add {
    border: 1px dashed #ccc; border-radius: 999px; padding: 5px 12px; font-size: 13px;
    color: var(--muted); background: none; transition: color .12s, border-color .12s;
  }
  .cat-add:hover { color: var(--fg); border-color: var(--fg); }
  .hero-rule { max-width: 900px; margin: 52px auto 0; border-top: 1px solid var(--faint); }

  /* two-column body: sticky TOC + article */
  .article-body {
    display: grid; grid-template-columns: 220px minmax(0, 720px); gap: 56px;
    justify-content: center; margin-top: 48px; align-items: start;
  }
  .toc { position: sticky; top: 92px; align-self: start; }
  .toc-label {
    font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
    margin-bottom: 12px;
  }
  .toc a {
    display: block; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4;
    color: var(--muted); transition: background .12s, color .12s;
  }
  .toc a.sub { padding-left: 24px; font-size: 13.5px; }
  .toc a:hover { color: var(--fg); }
  .toc a.active { background: var(--chip); color: var(--fg); }
  .toc.empty { display: none; }
  .article-body.no-toc { grid-template-columns: minmax(0, 760px); }

  .content { line-height: 1.8; font-size: 17px; }
  .content > :first-child { margin-top: 0; }
  .content h1 { font-size: 1.9em; font-weight: 650; letter-spacing: -0.02em; margin: 1.3em 0 .5em; }
  .content h2 { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; margin: 1.6em 0 .5em;
    scroll-margin-top: 92px; }
  .content h3 { font-size: 1.18em; font-weight: 600; margin: 1.3em 0 .3em; scroll-margin-top: 92px; }
  .content p { margin: 1em 0; }
  .content a { text-decoration: underline; text-decoration-color: #c8c8c8; text-underline-offset: 2px; }
  .content a:hover { text-decoration-color: var(--fg); }
  .content code { background: var(--chip); padding: .15em .4em; border-radius: 4px;
    font-family: var(--mono); font-size: 85%; }
  .content pre { background: #f7f7f6; border: 1px solid var(--faint); padding: 16px 18px;
    border-radius: 10px; overflow-x: auto; line-height: 1.5; }
  .content pre code { background: none; padding: 0; font-size: 13.5px; }
  .content blockquote { border-left: 3px solid var(--fg); margin: .8em 0; padding: 2px 0 2px 16px;
    color: var(--muted); }
  .content ul, .content ol { padding-left: 1.5em; }
  .content li { margin: .3em 0; }
  .content hr { border: none; border-top: 1px solid var(--faint); margin: 2em 0; }
  .content table { border-collapse: collapse; margin: 1em 0; font-size: 15px; }
  .content th, .content td { border: 1px solid var(--faint); padding: 7px 13px; text-align: left; }
  .content th { background: #f7f7f6; font-weight: 600; }
  .content img { max-width: 100%; border-radius: 8px; }
  .content pre.mermaid {
    background: none; border: none; padding: 12px 0; text-align: center;
    overflow-x: auto; line-height: normal;
  }
  .content pre.mermaid svg { max-width: 100%; height: auto; }

  .editor textarea {
    width: 100%; min-height: calc(100vh - 300px); border: 1px solid var(--faint);
    border-radius: 12px; outline: none; resize: vertical; padding: 22px;
    font-family: var(--mono); font-size: 14.5px; line-height: 1.7; color: var(--fg);
  }
  .editor-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .ed-btn {
    border: 1px solid var(--faint); border-radius: 999px; padding: 5px 14px; font-size: 13px;
    color: var(--muted); transition: color .12s, border-color .12s;
  }
  .ed-btn:hover, .ed-btn.active { color: var(--fg); border-color: #d6d6d6; }
  .ed-hint { color: var(--muted); font-size: 12.5px; }
  .editor-split { display: grid; grid-template-columns: 1fr; gap: 18px; }
  .editor-split.split { grid-template-columns: 1fr 1fr; }
  .editor-split .preview {
    min-height: calc(100vh - 300px); border: 1px solid var(--faint); border-radius: 12px;
    padding: 22px; overflow: auto;
  }
  @media (max-width: 720px) { .editor-split.split { grid-template-columns: 1fr; } }

  .toast {
    position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
    background: var(--fg); color: #fff; padding: 10px 18px; border-radius: 10px;
    font-size: 13.5px; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 50;
    max-width: 80vw;
  }
  .toast.show { opacity: .95; }

  /* Keep wheel/trackpad/keyboard scrolling, but remove the visual rails. */
  ::-webkit-scrollbar { display: none; width: 0; height: 0; }

  @media (max-width: 1024px) {
    .article-body, .article-body.no-toc { grid-template-columns: minmax(0, 760px); }
    .toc { display: none; }
  }
  /* Narrow screens: the panel floats over the content instead of pushing it. */
  @media (max-width: 760px) {
    body.sidebar-open { padding-left: 0; }
    body.sidebar-open #sidebar { box-shadow: 0 14px 50px rgba(0,0,0,.14); }
  }
  @media (max-width: 640px) {
    .page-title { font-size: 38px; }
    .hero-title { font-size: 36px; }
    .hero-sub { font-size: 16px; }
    .list.as-list .row { grid-template-columns: 1fr; gap: 8px; }
    .row-meta { flex-direction: row; gap: 12px; }
  }

  /* ---------- Desktop (Electron) window chrome ---------- */
  /* Electron gets a dedicated draggable titlebar containing only the native
     traffic lights and sidebar toggle. The browser keeps its toggle in #nav. */
  html.desktop .desktop-titlebar { display: flex; }
  html.desktop .browser-collapse { display: none; }
  html.desktop #sidebar { padding-top: var(--titlebar); border-right: none; }
  /* Draw the sidebar divider only below the shared titlebar. */
  html.desktop #sidebar::after {
    content: ''; position: absolute; top: var(--titlebar); right: 0; bottom: 0; width: 1px;
    background: var(--faint); pointer-events: none;
  }
  html.desktop #nav { margin-top: var(--titlebar); }
</style>
</head>
<body class="sidebar-open">
  <div id="desktopTitlebar" class="desktop-titlebar">
    <button class="nav-collapse" id="sideCollapse" data-sidebar-toggle title="${t('sidebar.toggle')}" aria-label="${t('sidebar.toggle')}">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
    </button>
  </div>
  <aside id="sidebar">
    <div class="side-brand" id="sideBrand" title="Wikinest">
      <span class="mark"><img class="brand-logo" src="/assets/icon.png" alt="" /></span>
      <span class="side-label">Wikinest</span>
    </div>
    <nav class="side-nav">
      <button class="side-item" data-side="all">
        <span class="ic"><svg viewBox="0 0 24 24"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg></span>
        <span class="side-label">${t('nav.allNotes')}</span><span class="side-count" id="cntAll"></span>
      </button>
      <button class="side-item" data-side="ask" id="askNav" style="display:none">
        <span class="ic"><svg viewBox="0 0 24 24"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/><path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg></span>
        <span class="side-label">${t('nav.ask')}</span>
      </button>
      <button class="side-item" data-side="digest">
        <span class="ic"><svg viewBox="0 0 24 24"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg></span>
        <span class="side-label">${t('nav.aiDigest')}</span><span class="side-count" id="cntDigest"></span>
      </button>
      <button class="side-item" data-side="recent">
        <span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg></span>
        <span class="side-label">${t('nav.recent')}</span>
      </button>
    </nav>
    <div class="side-sec">
      <div class="side-sec-label">${t('nav.categories')}</div>
      <div class="side-cats" id="sideCats"></div>
    </div>
    <div class="side-foot">
      <button class="mcp-mini" id="mcpAddr" title="${t('sidebar.mcpDetails')}">
        <span class="mcp-dot"></span>
        <span class="mcp-text">${t('nav.mcpRunning')}</span>
      </button>
      <button class="side-settings" id="sideSettings" title="${t('app.settings')}" aria-label="${t('sidebar.openSettings')}">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>${t('app.settings')}</span>
      </button>
    </div>
  </aside>

  <nav id="nav">
    <div class="nav-inner">
      <button class="nav-collapse browser-collapse" id="webSideCollapse" data-sidebar-toggle title="${t('sidebar.toggle')}" aria-label="${t('sidebar.toggle')}">
        <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
      </button>
      <div class="cmdbar" id="cmdbar">
        <svg class="cmd-ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="search" autocomplete="off" placeholder="${t('toolbar.search')}" />
        <kbd class="cmd-kbd" id="cmdKbd" style="display:none">${t('toolbar.askHint')}</kbd>
      </div>
      <div class="nav-right">
        <button class="btn-primary" id="newBtn">${t('toolbar.new')}</button>
        <button class="icon-btn" id="logoutBtn" title="${t('toolbar.logout')}" style="display:none">&#9099;</button>
      </div>
    </div>
  </nav>

  <main id="indexView" class="container">
    <div class="index-head">
      <h1 class="page-title" id="idxTitle">${t('nav.allNotes')}</h1>
      <span class="idx-count" id="idxCount"></span>
    </div>
    <div class="controls">
      <div class="cur-filter" id="curFilter"></div>
      <div class="control-right">
        <button class="ghost select-btn" id="selectBtn" title="${t('actions.synthesize')}" style="display:none"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>${t('actions.select')}</button>
        <button class="ghost" id="sortBtn">${t('actions.sortNewest')}</button>
        <div class="view-toggle">
          <button class="vt" data-view="grid" title="${t('actions.grid')}">&#9638;</button>
          <button class="vt active" data-view="list" title="${t('actions.list')}">&#9776;</button>
        </div>
      </div>
    </div>
    <div id="digestBanner"></div>
    <div class="list as-list" id="list"></div>
  </main>

  <main id="articleView" class="container" style="display:none">
    <div class="article-bar">
      <button class="backBtn" id="backBtn">${t('actions.backToList')}</button>
      <div class="article-actions">
        <button id="tidyBtn" style="display:none">${t('actions.tidy')}</button>
        <button id="editBtn">${t('actions.edit')}</button>
        <button id="renameBtn">${t('actions.rename')}</button>
        <button id="delBtn">${t('actions.delete')}</button>
        <button id="saveBtn" class="btn-primary" style="display:none">${t('app.save')}</button>
        <button id="cancelBtn" style="display:none">${t('app.cancel')}</button>
      </div>
    </div>

    <div id="articleRead">
      <div class="hero">
        <div class="hero-meta">
          <span class="date" id="artDate"></span>
          <span class="dot" id="artDot">·</span>
          <span class="cat" id="artCat"></span>
        </div>
        <h1 class="hero-title" id="artTitle"></h1>
        <p class="hero-sub" id="artSub"></p>
        <div class="cats" id="artCats"></div>
      </div>
      <div class="hero-rule"></div>
      <div class="article-body" id="articleBody">
        <nav class="toc" id="toc"></nav>
        <article class="content" id="content"></article>
      </div>
    </div>

    <div class="editor" id="editor" style="display:none">
      <div class="editor-tools">
        <button id="previewToggle" class="ed-btn">${t('actions.preview')}</button>
        <button id="aiTidyBtn" class="ed-btn" style="display:none">${t('actions.aiTidy')}</button>
        <span class="ed-hint">${t('editor.hint')}</span>
      </div>
      <div class="editor-split" id="editorSplit">
        <textarea id="ta" spellcheck="false"></textarea>
        <div class="content preview" id="preview" style="display:none"></div>
      </div>
    </div>
  </main>

  <main id="askView" class="container" style="display:none">
    <div class="ask-q" id="askQ"></div>
    <div class="ask-result" id="askResult"></div>
  </main>

  <div class="selection-bar" id="selectionBar">
    <span class="sb-count">${t('selection.count', { count: '<b id="selCount">0</b>' })}</span>
    <button class="sb-cancel" id="selCancel">${t('app.cancel')}</button>
    <button class="sb-go" id="selGo">${t('actions.synthesize')}</button>
  </div>

  <div class="set-overlay" id="setOverlay">
    <div class="set-modal" role="dialog" aria-modal="true" aria-label="${t('app.settings')}">
      <div class="set-head">
        <h2>${t('app.settings')}</h2>
        <span class="set-lead">${t('settings.lead')}</span>
      </div>
      <div class="set-body">
        <div class="set-group">
          <div class="set-legend">${t('settings.interface')}</div>
          <div class="set-note">${t('settings.interfaceNote')}</div>
          <div class="set-field">
            <label for="UI_LOCALE">${t('settings.interfaceLanguage')}</label>
            <select id="UI_LOCALE">
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('settings.vault')}</div>
          <div class="set-note">${t('settings.vaultNote')}</div>
          <div class="set-vault">
            <code id="setVaultPath">—</code>
            <button class="set-btn" id="setChooseVault">${t('settings.change')}</button>
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('settings.llm')}</div>
          <div class="set-note">${t('settings.llmNote')}</div>
          <div class="set-field">
            <label for="LLM_BASE_URL">Base URL</label>
            <input id="LLM_BASE_URL" placeholder="https://api.deepseek.com/v1" />
          </div>
          <div class="set-field">
            <label for="LLM_API_KEY">API Key</label>
            <input id="LLM_API_KEY" type="password" placeholder="sk-..." />
          </div>
          <div class="set-field">
            <label for="LLM_MODEL">${t('settings.model')}</label>
            <input id="LLM_MODEL" placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" />
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('settings.embedding')}</div>
          <div class="set-note">${t('settings.embeddingNote')}</div>
          <div class="set-field">
            <label for="EMBED_BASE_URL">Embed Base URL</label>
            <input id="EMBED_BASE_URL" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
          </div>
          <div class="set-grid2">
            <div class="set-field">
              <label for="EMBED_API_KEY">Embed API Key</label>
              <input id="EMBED_API_KEY" type="password" placeholder="sk-..." />
            </div>
            <div class="set-field">
              <label for="EMBED_MODEL">${t('settings.embedModel')}</label>
              <input id="EMBED_MODEL" placeholder="text-embedding-v4" />
            </div>
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('settings.storage')}</div>
          <div class="set-note">${t('settings.storageNote')}</div>
          <div class="set-grid2">
            <div class="set-field">
              <label for="S3_BUCKET">Bucket</label>
              <input id="S3_BUCKET" placeholder="my-wiki-images" />
            </div>
            <div class="set-field">
              <label for="S3_PUBLIC_BASE_URL">${t('settings.publicUrl')}</label>
              <input id="S3_PUBLIC_BASE_URL" placeholder="https://images.example.com" />
            </div>
          </div>
          <div class="set-grid2">
            <div class="set-field">
              <label for="S3_ACCESS_KEY_ID">Access Key ID</label>
              <input id="S3_ACCESS_KEY_ID" />
            </div>
            <div class="set-field">
              <label for="S3_SECRET_ACCESS_KEY">Secret Access Key</label>
              <input id="S3_SECRET_ACCESS_KEY" type="password" />
            </div>
          </div>
          <div class="set-grid2">
            <div class="set-field">
              <label for="S3_ENDPOINT">${t('settings.endpoint')}</label>
              <input id="S3_ENDPOINT" placeholder="https://<account>.r2.cloudflarestorage.com" />
            </div>
            <div class="set-field">
              <label for="S3_REGION">Region</label>
              <input id="S3_REGION" placeholder="auto" />
            </div>
          </div>
          <div class="set-grid2">
            <div class="set-field">
              <label for="S3_KEY_PREFIX">${t('settings.keyPrefix')}</label>
              <input id="S3_KEY_PREFIX" placeholder="wiki-images/" />
            </div>
            <div class="set-field">
              <label for="S3_FORCE_PATH_STYLE">${t('settings.pathStyle')}</label>
              <input id="S3_FORCE_PATH_STYLE" placeholder="${t('settings.trueOrBlank')}" />
            </div>
          </div>
        </div>
      </div>
      <div class="set-foot">
        <span class="set-status" id="setStatus"></span>
        <span class="spacer"></span>
        <button class="set-btn" id="setCancel">${t('app.cancel')}</button>
        <button class="set-btn primary" id="setSave">${t('app.save')}</button>
      </div>
    </div>
  </div>

  <div class="set-overlay" id="mcpOverlay">
    <div class="set-modal" role="dialog" aria-modal="true" aria-label="${t('mcp.title')}">
      <div class="set-head">
        <h2>${t('mcp.title')}</h2>
        <span class="set-lead">${t('mcp.lead')}</span>
      </div>
      <div class="set-body">
        <div class="mcp-status">
          <span class="mcp-dot"></span>
          <span>${t('mcp.serviceRunning')}</span>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('mcp.address')}</div>
          <div class="set-note">${t('mcp.addressNote')}</div>
          <div class="mcp-copy-row">
            <code class="mcp-code" id="mcpLocalAddress">http://127.0.0.1:4321/mcp</code>
            <button class="set-btn" id="mcpCopyAddress">${t('mcp.copy')}</button>
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('mcp.cursorConfig')}</div>
          <div class="set-note">${t('mcp.cursorNote')}</div>
          <div class="mcp-copy-row">
            <pre class="mcp-code" id="mcpCursorConfig">{
  "mcpServers": {
    "wikinest-local": {
      "url": "http://127.0.0.1:4321/mcp"
    }
  }
}</pre>
            <button class="set-btn" id="mcpCopyCursor">${t('mcp.copyConfig')}</button>
          </div>
        </div>

        <div class="set-group">
          <div class="set-legend">${t('mcp.claudeConfig')}</div>
          <div class="set-note">${t('mcp.claudeNote')}</div>
          <div class="mcp-copy-row">
            <code class="mcp-code" id="mcpClaudeCommand">claude mcp add --scope user --transport http wikinest-local http://127.0.0.1:4321/mcp</code>
            <button class="set-btn" id="mcpCopyClaude">${t('mcp.copyCommand')}</button>
          </div>
        </div>
      </div>
      <div class="set-foot">
        <span class="spacer"></span>
        <button class="set-btn" id="mcpClose">${t('app.close')}</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
const UI_LOCALE = ${JSON.stringify(normalized)};
const UI_MESSAGES = ${clientMessages};
function tr(key, params = {}) {
  const template = UI_MESSAGES[key] || key;
  return template.replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? '{' + name + '}'));
}
const $ = (id) => document.getElementById(id);
const TAB_ALL = '__all__';
const TAB_UNCATEGORIZED = '__uncategorized__';
const DATE_FORMATTER = new Intl.DateTimeFormat(UI_LOCALE, {
  year: 'numeric', month: 'short', day: 'numeric',
});

let items = [];          // index items {path, folder, title, date, desc}
let activeTab = TAB_ALL;
let sortNewest = true;
let viewMode = 'list';
let recentMode = false;  // "最近" nav entry: latest notes across all folders
let digestMode = false;  // sidebar "AI 综述": list only digest notes
let selectMode = false;  // multi-select mode: pick notes → synthesize one article
let ragEnabled = false;  // semantic search / ask available (embeddings configured)
const selected = new Set(); // paths chosen while in select mode
const RECENT_LIMIT = 8;
let current = null;      // current note path (article view)
let currentRaw = '';
let draftMode = false;   // "新建" opened a blank editor not yet saved
let draftTidied = false; // whether the draft was already AI-tidied

const ERROR_MESSAGE_KEYS = {
  LLM_NOT_CONFIGURED: 'errors.llmNotConfigured',
  STORAGE_NOT_CONFIGURED: 'errors.storageNotConfigured',
  RAG_NOT_CONFIGURED: 'errors.ragNotConfigured',
  UNAUTHORIZED: 'errors.unauthorized',
  INVALID_CREDENTIALS: 'errors.invalidCredentials',
  RATE_LIMITED: 'errors.rateLimited',
};

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    // Session expired or missing → send the owner to the login page.
    location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const key = ERROR_MESSAGE_KEYS[body.code];
    const message = key
      ? tr(key)
      : tr('errors.operationFailed', { message: body.error || r.statusText });
    throw new Error(message);
  }
  return r.json();
}

function topFolder(folder) {
  if (!folder) return TAB_UNCATEGORIZED;
  return folder.split('/')[0];
}

function categoryLabel(value) {
  if (value === TAB_ALL) return tr('nav.allNotes');
  if (value === TAB_UNCATEGORIZED) return tr('categories.uncategorized');
  return value;
}

// What counts as a browsable "note" in the list/category views: real notes plus
// hand-picked custom syntheses (which carry their sources' categories). Only the
// auto category-level digests stay out of the list (they show as a banner).
function isNote(i) { return !i.digest || i.custom; }

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return DATE_FORMATTER.format(d);
}

async function loadIndex() {
  items = await api('/api/index');
  renderTabs();
  updateSideCounts();
  renderList();
}

// ---------- left icon rail ----------
function updateSideCounts() {
  const notes = items.filter(isNote).length;
  const digests = items.filter(i => i.digest).length;
  const a = $('cntAll'); if (a) a.textContent = notes;
  const d = $('cntDigest');
  if (d) { d.textContent = digests; d.style.display = digests ? '' : 'none'; }
}

function setActiveSide(which) {
  document.querySelectorAll('.side-item').forEach(b =>
    b.classList.toggle('active', b.dataset.side === which));
}

// "AI 综述": show only the AI-generated digest notes as a list.
function showDigests() {
  showIndex();
  digestMode = true;
  recentMode = false;
  activeTab = TAB_ALL;
  $('search').value = '';
  renderTabs();
  $('digestBanner').innerHTML = '';
  const list = items.filter(i => i.digest)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path));
  const el = $('list');
  el.className = 'list as-list';
  if (!list.length) {
    el.innerHTML = '<div class="empty">' + tr('empty.noDigests') + '</div>';
  } else {
    renderList(list);
  }
  setActiveSide('digest');
}

// Pin the sidebar open or collapse it to the icon rail; remember the choice.
const SIDEBAR_KEY = 'wiki_sidebar_open';
function applySidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch (e) {}
}

function wireSidebar() {
  const brand = $('sideBrand');
  if (brand) brand.onclick = () => { showIndex(); selectTab(TAB_ALL); };

  // Desktop and browser render the toggle in different rows, but share the
  // same sidebar state and behavior.
  document.querySelectorAll('[data-sidebar-toggle]').forEach((toggle) => {
    toggle.onclick = () => applySidebar(!document.body.classList.contains('sidebar-open'));
  });

  document.querySelectorAll('.side-item').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.side;
      if (act === 'all') { showIndex(); selectTab(TAB_ALL); }
      else if (act === 'ask') { openAsk(); }
      else if (act === 'digest') { showDigests(); }
      else if (act === 'recent') { showIndex(); showRecent(); }
    };
  });

  // Settings is a persistent sidebar-footer action in the desktop app. Vault
  // switching remains inside that modal; browsers do not expose the IPC bridge.
  const settingsButton = $('sideSettings');
  if (settingsButton && window.wikiSettings) {
    settingsButton.classList.add('desktop-visible');
    settingsButton.onclick = openSettings;
  }

  const addr = $('mcpAddr');
  if (addr) {
    addr.onclick = openMcpModal;
  }
}

function showRecent() {
  recentMode = true;
  digestMode = false;
  activeTab = TAB_ALL;
  $('search').value = '';
  renderTabs();
  renderList();
}

// Categories now live in the left rail instead of a top tab row. This fills the
// "分类" section, updates the current-filter caption and the active highlight.
function renderTabs() {
  const set = new Set();
  let hasUncat = false;
  for (const i of items) {
    if (!isNote(i)) continue; // auto category digests aren't a category
    const cs = i.categories || [];
    if (cs.length) cs.forEach(c => set.add(c));
    else hasUncat = true;
  }
  const cats = [...set].sort((a, b) => a.localeCompare(b));
  const wrap = $('sideCats');
  if (wrap) {
    wrap.innerHTML = '';
    const addRow = (name) => {
      const count = name === TAB_UNCATEGORIZED
        ? items.filter(i => isNote(i) && !(i.categories || []).length).length
        : items.filter(i => isNote(i) && (i.categories || []).includes(name)).length;
      const b = document.createElement('button');
      b.className = 'side-item';
      b.dataset.side = name;
      b.innerHTML = '<span class="cat-dot"></span><span class="side-label"></span><span class="side-count"></span>';
      b.querySelector('.side-label').textContent = categoryLabel(name);
      b.querySelector('.side-count').textContent = count;
      b.onclick = () => { showIndex(); selectTab(name); };
      wrap.appendChild(b);
    };
    cats.forEach(addRow);
    if (hasUncat) addRow(TAB_UNCATEGORIZED);
  }
  updateCurFilter();
  syncActiveSide();
}

// Drive the contextual page title + count: which slice you're viewing.
function updateCurFilter() {
  const notes = items.filter(isNote);
  let label, n;
  if (recentMode) { label = tr('nav.recent'); n = Math.min(RECENT_LIMIT, notes.length); }
  else if (digestMode) { label = tr('nav.aiDigest'); n = items.filter(i => i.digest).length; }
  else if (activeTab === TAB_ALL) { label = tr('nav.allNotes'); n = notes.length; }
  else if (activeTab === TAB_UNCATEGORIZED) { label = tr('categories.uncategorized'); n = notes.filter(i => !(i.categories || []).length).length; }
  else { label = activeTab; n = notes.filter(i => (i.categories || []).includes(activeTab)).length; }
  const t = $('idxTitle'); if (t) t.textContent = label;
  const c = $('idxCount'); if (c) c.textContent = tr('notes.count', { count: n });
  const cf = $('curFilter'); if (cf) cf.textContent = '';
}

// Highlight the rail entry matching the current view.
function syncActiveSide() {
  let key = 'all';
  if (recentMode) key = 'recent';
  else if (digestMode) key = 'digest';
  else if (activeTab !== TAB_ALL) key = activeTab;
  setActiveSide(key);
}

function selectTab(c) {
  activeTab = c;
  recentMode = false;
  digestMode = false;
  $('search').value = '';
  renderTabs();
  renderList();
}

function currentItems() {
  // Auto category digests show as a banner; custom syntheses show as rows.
  let list = items.filter(isNote);
  if (!recentMode && activeTab !== TAB_ALL) {
    if (activeTab === TAB_UNCATEGORIZED) list = list.filter(i => !(i.categories || []).length);
    else list = list.filter(i => (i.categories || []).includes(activeTab));
  }
  list.sort((a, b) => {
    const cmp = (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path);
    // "最近" always shows newest first regardless of the sort toggle.
    return (recentMode || sortNewest) ? cmp : -cmp;
  });
  return recentMode ? list.slice(0, RECENT_LIMIT) : list;
}

function renderList(list) {
  const custom = !!list;
  const data = list || currentItems();
  // Banner only while normally browsing a category (not during search).
  if (custom) $('digestBanner').innerHTML = ''; else renderDigestBanner();
  const el = $('list');
  el.className = 'list ' + (viewMode === 'grid' ? 'as-grid' : 'as-list') + (selectMode ? ' selecting' : '');
  if (!data.length) { el.innerHTML = '<div class="empty">' + tr('empty.noNotes') + '</div>'; return; }
  el.innerHTML = '';
  for (const it of data) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<div class="row-meta"><span class="row-cat"></span><span class="row-date"></span></div>' +
      '<div><div class="row-title"></div><div class="row-desc"></div></div>';
    row.querySelector('.row-cat').textContent =
      (it.categories && it.categories.length) ? it.categories.join(tr('punctuation.listSeparator')) : tr('categories.uncategorized');
    row.querySelector('.row-date').textContent = fmtDate(it.date);
    row.querySelector('.row-title').textContent = it.title;
    if (it.digest) {
      row.querySelector('.row-title').insertAdjacentHTML('afterbegin', '<span class="row-badge">' + tr('badge.digest') + '</span>');
    }
    row.querySelector('.row-desc').textContent = it.desc || '';
    if (selectMode) {
      const chk = document.createElement('div');
      chk.className = 'row-check';
      chk.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
      row.prepend(chk);
      if (it.digest) {
        // A synthesis can't be a source for another synthesis — make it unpickable.
        row.classList.add('nosel');
        row.onclick = () => toast(tr('selection.digestUnavailable'));
      } else {
        if (selected.has(it.path)) row.classList.add('sel');
        row.onclick = () => {
          if (selected.has(it.path)) { selected.delete(it.path); row.classList.remove('sel'); }
          else { selected.add(it.path); row.classList.add('sel'); }
          updateSelectionBar();
        };
      }
    } else {
      row.onclick = () => openNote(it.path);
    }
    el.appendChild(row);
  }
}

// ---------- multi-select → synthesize one article ----------
function toggleSelectMode(on) {
  selectMode = (on === undefined) ? !selectMode : on;
  const btn = $('selectBtn');
  if (btn) btn.classList.toggle('active', selectMode);
  if (!selectMode) selected.clear();
  renderList();
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = $('selectionBar');
  if (!bar) return;
  $('selCount').textContent = selected.size;
  bar.classList.toggle('show', selectMode && selected.size > 0);
  const go = $('selGo');
  if (go) go.disabled = selected.size < 2;
}

async function synthSelection() {
  const paths = [...selected];
  if (paths.length < 2) { toast(tr('selection.atLeastTwo')); return; }
  const go = $('selGo'); const label = go.textContent;
  go.disabled = true; go.textContent = tr('status.synthesizing');
  toast(tr('toast.synthesizing'), 60000);
  try {
    // Title left empty on purpose → the server lets the model name it.
    const r = await api('/api/digest/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, title: '' }),
    });
    toggleSelectMode(false);
    await loadIndex();
    await openNote(r.path);
    toast(tr('toast.synthesized', { title: r.title || tr('badge.digest') }));
  } catch (e) {
    alert(tr('errors.synthesisFailed', { message: e.message }));
  } finally {
    go.disabled = false; go.textContent = label;
  }
}

// ---------- category digest (AI 综述) ----------
function renderDigestBanner() {
  const el = $('digestBanner');
  if (!el) return;
  el.innerHTML = '';
  // Only for a specific real category (not 全部 / 未分类 / 最近).
  if (recentMode || activeTab === TAB_ALL || activeTab === TAB_UNCATEGORIZED) return;
  const cat = activeTab;
  const digestItem = items.find(i => i.digest && !i.custom && i.category === cat);
  const count = items.filter(i => !i.digest && (i.categories || []).includes(cat)).length;
  if (!digestItem && !organizeEnabled) return; // nothing actionable to show

  const card = document.createElement('div');
  card.className = 'digest-card';
  const main = document.createElement('div'); main.className = 'dc-main';
  const t = document.createElement('div'); t.className = 'dc-title';
  t.textContent = tr('digest.title', { category: cat });
  const sub = document.createElement('div'); sub.className = 'dc-sub';
  main.appendChild(t); main.appendChild(sub);
  const actions = document.createElement('div'); actions.className = 'dc-actions';

  if (digestItem) {
    sub.textContent = tr('digest.basedOn', { count }) +
      (digestItem.date ? tr('digest.updatedAt', { date: fmtDate(digestItem.date) }) : '');
    const view = document.createElement('button');
    view.className = 'primary'; view.textContent = tr('digest.view');
    view.onclick = () => openNote(digestItem.path);
    actions.appendChild(view);
    if (organizeEnabled) {
      const upd = document.createElement('button');
      upd.textContent = tr('digest.update'); upd.onclick = () => genDigest(cat);
      actions.appendChild(upd);
    }
  } else {
    sub.textContent = tr('digest.description', { count });
    const gen = document.createElement('button');
    gen.className = 'primary'; gen.textContent = tr('digest.generate'); gen.onclick = () => genDigest(cat);
    actions.appendChild(gen);
  }
  card.appendChild(main); card.appendChild(actions);
  el.appendChild(card);
}

async function genDigest(cat) {
  toast(tr('toast.digestGenerating'), 60000);
  try {
    const r = await api('/api/digest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: cat }),
    });
    await loadIndex();
    await openNote(r.path);
    toast(tr('toast.digestGenerated'));
  } catch (e) { alert(tr('errors.digestFailed', { message: e.message })); }
}

// ---------- view switching ----------
function showIndex() {
  $('articleView').style.display = 'none';
  $('askView').style.display = 'none';
  $('indexView').style.display = '';
  current = null;
  draftMode = false;
  window.scrollTo(0, 0);
}

function showArticle() {
  $('indexView').style.display = 'none';
  $('askView').style.display = 'none';
  $('articleView').style.display = '';
  window.scrollTo(0, 0);
}

// ---------- ask your wiki (RAG) ----------
// The only input is the top command bar; this view just renders results.
const ASK_SAMPLES = [
  tr('ask.example1'),
  tr('ask.example2'),
  tr('ask.example3'),
];

function askEmptyHTML() {
  const chips = ASK_SAMPLES.map(s => '<button class="ask-chip">' + s + '</button>').join('');
  return '<div class="ask-empty">'
    + '<div class="ee-title">' + tr('ask.title') + '</div>'
    + '<div class="ee-sub">' + tr('ask.description') + '</div>'
    + '<div class="ask-chips">' + chips + '</div></div>';
}

function showAskView() {
  $('indexView').style.display = 'none';
  $('articleView').style.display = 'none';
  $('askView').style.display = '';
  setActiveSide('ask');
  window.scrollTo(0, 0);
}

// Sidebar "问一问": open a fresh, empty ask page and focus the command bar.
function openAsk() {
  showAskView();
  $('askQ').textContent = '';
  $('askResult').innerHTML = askEmptyHTML();
  delete $('askResult').dataset.answered;
  setTimeout(() => $('search').focus(), 0);
}

async function doAsk(query) {
  const q = (query != null ? query : $('search').value).trim();
  if (!q) { $('search').focus(); return; }
  showAskView();
  $('askQ').textContent = q;
  $('askResult').dataset.answered = '1';
  $('askResult').innerHTML = '<div class="ask-loading">' + tr('ask.loading') + '</div>';
  try {
    const r = await api('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    $('askResult').innerHTML = '<div class="ask-answer content"></div>';
    $('askResult').querySelector('.ask-answer').innerHTML = r.html || tr('ask.noContent');
  } catch (e) {
    $('askResult').innerHTML = '<div class="ask-loading">' + tr('ask.failed', { message: e.message }) + '</div>';
  }
}

let tocObserver = null;

async function openNote(path) {
  draftMode = false;
  const note = await api('/api/note?path=' + encodeURIComponent(path));
  current = note.path; currentRaw = note.content;
  const meta = items.find(i => i.path === note.path);
  const title = (note.data && note.data.title) || (meta ? meta.title : note.path.split('/').pop().replace(/\\.md$/, ''));
  const date = meta ? fmtDate(meta.date) : '';
  $('artTitle').textContent = title;
  $('artDate').textContent = date;
  $('artCat').style.display = 'none';
  $('artDot').style.display = 'none';
  $('artSub').textContent = meta && meta.desc ? meta.desc : '';
  $('artSub').style.display = (meta && meta.desc) ? '' : 'none';
  renderCats((note.data && note.data.categories) || []);
  showArticle();
  showView(note.html);
}

function showView(html) {
  $('editor').style.display = 'none';
  $('articleRead').style.display = '';
  $('content').innerHTML = html || '<p style="color:var(--muted)">' + tr('article.empty') + '</p>';
  buildToc();
  renderMermaid();
  $('editBtn').style.display = ''; $('delBtn').style.display = ''; $('renameBtn').style.display = '';
  $('tidyBtn').style.display = organizeEnabled ? '' : 'none';
  $('saveBtn').style.display = 'none'; $('cancelBtn').style.display = 'none';
}

let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Electron's renderer does not implement window.prompt(): calling it is a no-op
// that returns null, so rename / add-category flows silently do nothing in the
// desktop app. This in-page dialog is the drop-in replacement (resolves to the
// entered string, or null when cancelled) and works in the browser too.
function promptDialog(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'set-overlay show';
    overlay.style.alignItems = 'center';
    const box = document.createElement('div');
    box.style.cssText = 'width:100%;max-width:420px;background:var(--bg);color:var(--fg);'
      + 'border:1px solid var(--faint);border-radius:14px;padding:20px;'
      + 'box-shadow:0 24px 60px rgba(0,0,0,.28);font-family:var(--sans);';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'font-size:14px;line-height:1.4;margin-bottom:12px;white-space:pre-wrap;';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.style.cssText = 'width:100%;font-size:14px;padding:9px 11px;border:1px solid var(--faint);'
      + 'border-radius:9px;background:#fff;color:var(--fg);outline:none;font-family:var(--sans);';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:16px;';
    const cancel = document.createElement('button');
    cancel.textContent = tr('app.cancel');
    cancel.style.cssText = 'padding:8px 16px;border-radius:9px;border:1px solid var(--faint);'
      + 'background:var(--bg);color:var(--fg);font-size:13.5px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = tr('app.save');
    ok.style.cssText = 'padding:8px 16px;border-radius:9px;border:1px solid var(--fg);'
      + 'background:var(--fg);color:#fff;font-size:13.5px;cursor:pointer;';

    let done = false;
    const close = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
    };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(input.value);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// Lazily load mermaid (a ~3MB module) only the first time a diagram actually
// needs rendering. Most notes have none, so this keeps startup fast. Served
// locally from /vendor (bundled in node_modules) so it works fully offline.
let mermaidLoading = null;
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = import('/vendor/mermaid/mermaid.esm.min.mjs')
      .then((m) => {
        const mermaid = m.default;
        mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', fontFamily: 'inherit' });
        window.mermaid = mermaid;
        return mermaid;
      });
  }
  return mermaidLoading;
}

// Turn any <pre class="mermaid"> blocks in the article into SVG diagrams.
async function renderMermaid() {
  const nodes = [...$('content').querySelectorAll('pre.mermaid:not([data-processed])')];
  if (!nodes.length) return;
  try { const mermaid = await ensureMermaid(); await mermaid.run({ nodes }); }
  catch (err) { console.error('mermaid render failed:', err); }
}

// Build the left-hand table of contents from the article's headings, and
// highlight the section currently in view (scroll spy).
function buildToc() {
  const toc = $('toc');
  const body = $('articleBody');
  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  const heads = [...$('content').querySelectorAll('h2, h3')];
  toc.innerHTML = '';
  if (heads.length < 2) {
    toc.className = 'toc empty';
    body.className = 'article-body no-toc';
    return;
  }
  toc.className = 'toc';
  body.className = 'article-body';
  const links = new Map();
  heads.forEach((h, i) => {
    const id = 'sec-' + i;
    h.id = id;
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.href = '#' + id;
    if (h.tagName === 'H3') a.className = 'sub';
    a.onclick = (e) => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth' }); };
    toc.appendChild(a);
    links.set(id, a);
  });
  tocObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        links.forEach(a => a.classList.remove('active'));
        links.get(en.target.id)?.classList.add('active');
      }
    }
  }, { rootMargin: '-90px 0px -70% 0px', threshold: 0 });
  heads.forEach(h => tocObserver.observe(h));
}

// "新建":直接进入一个空白编辑区,粘贴/书写,保存时 AI 自动整理排版并归类。
function startDraft() {
  if (selectMode) toggleSelectMode(false);
  draftMode = true;
  draftTidied = false;
  current = null;
  currentRaw = '';
  showArticle();
  $('articleRead').style.display = 'none';
  $('editor').style.display = '';
  $('ta').value = '';
  $('ta').placeholder = tr('editor.placeholder');
  $('editBtn').style.display = 'none'; $('delBtn').style.display = 'none'; $('renameBtn').style.display = 'none';
  $('tidyBtn').style.display = 'none';
  $('aiTidyBtn').style.display = organizeEnabled ? '' : 'none';
  $('saveBtn').style.display = ''; $('cancelBtn').style.display = '';
  $('ta').focus();
  updatePreview();
}

// A title the user explicitly wrote as the first heading, if any ('' otherwise).
function firstHeading(md) {
  for (const line of (md || '').split('\\n')) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^#{1,6}\\s+(.+)/);
    return h ? h[1].trim().slice(0, 60) : '';
  }
  return '';
}

// Last-resort title when AI naming is unavailable: first non-empty line.
function deriveTitle(md) {
  for (const line of (md || '').split('\\n')) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/[*_>#\\-]/g, '').trim().slice(0, 60);
  }
  return tr('editor.untitled');
}

async function saveDraft() {
  const raw = $('ta').value.trim();
  if (!raw) { toast(tr('toast.emptyContent')); return; }
  const btn = $('saveBtn'); const label = btn.textContent;
  btn.disabled = true;
  try {
    let content = raw;
    // AI check/tidy the formatting before saving (unless already tidied).
    if (organizeEnabled && !draftTidied) {
      btn.textContent = tr('status.aiTidying');
      toast(tr('toast.aiTidying'), 30000);
      try {
        const t = await api('/api/tidy/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        if (t.content) content = t.content;
      } catch (e) { /* fall back to raw content */ }
    }
    // Title: use the heading the user wrote; otherwise let AI name it;
    // only fall back to truncating the first line if AI is unavailable.
    let title = firstHeading(content);
    if (!title && organizeEnabled) {
      btn.textContent = tr('status.aiNaming');
      try {
        const titleResult = await api('/api/title', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        title = (titleResult.title || '').trim();
      } catch (e) { /* fall back below */ }
    }
    if (!title) title = deriveTitle(content);
    const slug = title.replace(/[\\s\\/\\\\]+/g, '-').slice(0, 60) || ('note-' + Date.now());
    btn.textContent = tr('status.saving');
    if (classifyEnabled) toast(tr('toast.savingClassifying'), 30000);
    const r = await api('/api/note', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/' + slug, content, frontmatter: { title }, unique: true }),
    });
    draftMode = false;
    await loadIndex();
    await openNote(r.path);
    toast((r.categories && r.categories.length)
      ? tr('toast.savedCategories', { categories: r.categories.join(tr('punctuation.listSeparator')) })
      : tr('toast.saved'));
  } catch (e) {
    alert(tr('errors.saveFailed', { message: e.message }));
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function showEdit() {
  $('articleRead').style.display = 'none';
  $('editor').style.display = '';
  $('ta').value = currentRaw;
  $('editBtn').style.display = 'none'; $('delBtn').style.display = 'none'; $('renameBtn').style.display = 'none';
  $('tidyBtn').style.display = 'none';
  $('aiTidyBtn').style.display = organizeEnabled ? '' : 'none';
  $('saveBtn').style.display = ''; $('cancelBtn').style.display = '';
  $('ta').focus();
  updatePreview();
}

// ---------- live preview ----------
let previewOn = false;
let previewTimer;
async function updatePreview() {
  if (!previewOn) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await api('/api/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: $('ta').value }),
      });
      $('preview').innerHTML = r.html || '';
      const nodes = [...$('preview').querySelectorAll('pre.mermaid:not([data-processed])')];
      if (nodes.length) {
        try { const mermaid = await ensureMermaid(); await mermaid.run({ nodes }); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore transient render errors */ }
  }, 300);
}

// ---------- events ----------
$('backBtn').onclick = () => { showIndex(); };
$('editBtn').onclick = showEdit;
$('cancelBtn').onclick = () => {
  if (draftMode) { draftMode = false; showIndex(); }
  else openNote(current);
};

// Intercept in-app note links (href="#note=<path>") inside rendered articles,
// e.g. the "参考来源" links in an AI digest, and open them without a reload.
$('content').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.indexOf('#note=') === 0) {
    e.preventDefault();
    try { openNote(decodeURIComponent(href.slice(6))); } catch (_) { /* ignore */ }
  }
});

$('previewToggle').onclick = () => {
  previewOn = !previewOn;
  $('previewToggle').classList.toggle('active', previewOn);
  $('editorSplit').classList.toggle('split', previewOn);
  $('preview').style.display = previewOn ? '' : 'none';
  if (previewOn) updatePreview();
};

$('renameBtn').onclick = async () => {
  if (!current) return;
  const cur = current.replace(/\\.md$/, '');
  const to = await promptDialog(tr('rename.prompt'), cur);
  if (!to || !to.trim() || to.trim() === cur) return;
  try {
    const r = await api('/api/note/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: current, to: to.trim() }),
    });
    toast(tr('toast.renamed'));
    await loadIndex();
    await openNote(r.path);
  } catch (e) { alert(tr('errors.renameFailed', { message: e.message })); }
};

// ---------- categories ----------
let classifyEnabled = false;

// AI organize (tidy + synthesize) — same LLM config; gates the AI buttons.
let organizeEnabled = false;

$('selectBtn').onclick = () => toggleSelectMode();
$('selCancel').onclick = () => toggleSelectMode(false);
$('selGo').onclick = synthSelection;

// ---------- ask (RAG) wiring ----------

$('askResult').addEventListener('click', (e) => {
  // Example-question chip → run that question.
  const chip = e.target.closest('.ask-chip');
  if (chip) { $('search').value = chip.textContent; doAsk(chip.textContent); return; }
  // Source citations inside an answer open the note in-app (same as article links).
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.indexOf('#note=') === 0) {
    e.preventDefault();
    try { openNote(decodeURIComponent(href.slice(6))); } catch (_) { /* ignore */ }
  }
});

// Tidy the currently open note in place (overwrites body with cleaned markdown).
$('tidyBtn').onclick = async () => {
  if (!current) return;
  if (!confirm(tr('tidy.confirm'))) return;
  const btn = $('tidyBtn'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr('status.tidying');
  toast(tr('status.tidying'), 30000);
  try {
    const r = await api('/api/tidy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current }),
    });
    await loadIndex();
    await openNote(r.path);
    toast(tr('toast.tidied'));
  } catch (e) { alert(tr('errors.tidyFailed', { message: e.message })); }
  finally { btn.disabled = false; btn.textContent = label; }
};

// Non-destructive tidy inside the editor: fill the textarea, user saves manually.
$('aiTidyBtn').onclick = async () => {
  const ta = $('ta');
  if (!ta.value.trim()) return;
  const btn = $('aiTidyBtn'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr('status.tidying');
  try {
    const r = await api('/api/tidy/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ta.value }),
    });
    ta.value = r.content || ta.value;
    draftTidied = true;
    updatePreview();
    toast(tr('toast.tidiedPending'));
  } catch (e) { alert(tr('errors.tidyFailed', { message: e.message })); }
  finally { btn.disabled = false; btn.textContent = label; }
};

function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }

function renderCats(catsRaw) {
  const cats = asArray(catsRaw);
  const el = $('artCats');
  el.innerHTML = '';
  cats.forEach(c => {
    const chip = document.createElement('span');
    chip.className = 'cat-chip';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = c; name.title = tr('categories.clickToRename');
    name.onclick = () => renameCat(c);
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '✕'; x.title = tr('categories.removeFromNote');
    x.onclick = () => setCurrentCats(cats.filter(v => v !== c));
    chip.appendChild(name); chip.appendChild(x);
    el.appendChild(chip);
  });
  const add = document.createElement('button');
  add.className = 'cat-add'; add.textContent = tr('categories.add');
  add.onclick = async () => {
    const name = await promptDialog(tr('categories.addPrompt'));
    if (name && name.trim()) setCurrentCats([...new Set([...cats, name.trim()])]);
  };
  el.appendChild(add);
  if (classifyEnabled) {
    const auto = document.createElement('button');
    auto.className = 'cat-add'; auto.textContent = tr('categories.auto');
    auto.onclick = autoClassifyCurrent;
    el.appendChild(auto);
  }
}

async function setCurrentCats(cats) {
  if (!current) return;
  const r = await api('/api/note/categories', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: current, categories: cats }),
  });
  await loadIndex();
  renderCats(r.categories || cats);
}

async function renameCat(oldName) {
  const to = await promptDialog(tr('categories.renamePrompt', { name: oldName }), oldName);
  if (!to || !to.trim() || to.trim() === oldName) return;
  await api('/api/categories/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: oldName, to: to.trim() }),
  });
  await loadIndex();
  await openNote(current);
}

async function autoClassifyCurrent() {
  toast(tr('categories.classifying'), 8000);
  try {
    const r = await api('/api/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current }),
    });
    await loadIndex();
    renderCats(r.categories || []);
    toast(tr('categories.classified', {
      categories: (r.categories || []).join(tr('punctuation.listSeparator')),
    }));
  } catch (e) { alert(tr('categories.autoFailed', { message: e.message })); }
}

// ---------- image upload (paste / drag-drop into the editor) ----------
let uploadEnabled = false;

// Insert text at the textarea caret, replacing the current selection.
function insertAtCaret(ta, text) {
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
}

// Replace a one-off placeholder token with the final markdown (or remove it).
function replaceToken(ta, token, replacement) {
  ta.value = ta.value.replace(token, replacement);
}

async function uploadFile(file) {
  const ta = $('ta');
  if (!uploadEnabled) {
    alert(tr('upload.disabled'));
    return;
  }
  const token = '![' + tr('upload.uploading') + ' ' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + ']()';
  insertAtCaret(ta, token + '\\n');
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name || 'image'),
      },
      body: file,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const key = ERROR_MESSAGE_KEYS[data.code];
      throw new Error(key ? tr(key) : (data.error || r.statusText));
    }
    const alt = (file.name || 'image').replace(/\\.[^.]+$/, '');
    replaceToken(ta, token, '![' + alt + '](' + data.url + ')');
  } catch (err) {
    replaceToken(ta, token, '');
    alert(tr('errors.uploadFailed', { message: err.message }));
  }
}

function handleFiles(files) {
  const imgs = [...files].filter(f => f.type && f.type.startsWith('image/'));
  imgs.forEach(uploadFile);
  return imgs.length > 0;
}

$('ta').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter(it => it.kind === 'file')
    .map(it => it.getAsFile())
    .filter(Boolean);
  if (files.length && handleFiles(files)) e.preventDefault();
});

$('ta').addEventListener('dragover', (e) => { e.preventDefault(); });
$('ta').addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) {
    if (handleFiles(e.dataTransfer.files)) e.preventDefault();
  }
});
$('ta').addEventListener('input', updatePreview);

$('saveBtn').onclick = async () => {
  if (draftMode) return saveDraft();
  const btn = $('saveBtn');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr('status.saving');
  if (classifyEnabled) toast(tr('toast.savingClassifying'), 8000);
  try {
    const r = await api('/api/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current, content: $('ta').value }) });
    await loadIndex();
    await openNote(current);
    toast((r.categories && r.categories.length)
      ? tr('toast.savedCategories', { categories: r.categories.join(tr('punctuation.listSeparator')) })
      : tr('toast.saved'));
  } catch (e) {
    alert(tr('errors.saveFailed', { message: e.message }));
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
};

$('newBtn').onclick = () => startDraft();

$('delBtn').onclick = async () => {
  if (!current || !confirm(tr('delete.confirm', { path: current }))) return;
  await api('/api/note?path=' + encodeURIComponent(current), { method: 'DELETE' });
  await loadIndex();
  showIndex();
};

$('sortBtn').onclick = () => {
  sortNewest = !sortNewest;
  $('sortBtn').textContent = tr('sort.label', {
    order: tr(sortNewest ? 'sort.newest' : 'sort.oldest'),
  });
  renderList();
};

document.querySelectorAll('.vt').forEach(b => {
  b.onclick = () => {
    viewMode = b.dataset.view;
    document.querySelectorAll('.vt').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  };
});

$('logoutBtn').onclick = async () => {
  try { await fetch('/logout', { method: 'POST' }); } catch (e) {}
  location.assign('/login');
};

// Show the logout button only when a password is configured (auth in use).
(async () => {
  try {
    const s = await fetch('/api/auth/status').then(r => r.json());
    if (s && s.required) $('logoutBtn').style.display = '';
  } catch (e) {}
})();

let searchTimer;
// Typing = live keyword find in the list. Enter = ask (semantic + AI answer).
$('search').oninput = (e) => {
  clearTimeout(searchTimer);
  // Don't hijack the view while editing a note or reading an answer.
  if ($('editor').style.display !== 'none') return;
  if ($('askView').style.display !== 'none') return;
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (!q) {
      if ($('indexView').style.display !== 'none') { renderList(); updateCurFilter(); }
      return;
    }
    showIndex();
    let hits = [];
    try { hits = await api('/api/search?q=' + encodeURIComponent(q)); } catch (_) { hits = []; }
    // Map search hits onto index items (for folder/date), fall back to snippet.
    const mapped = hits.map(h => {
      const it = items.find(i => i.path === h.path);
      return it ? { ...it, desc: h.snippet } : { path: h.path, folder: '', title: h.title, date: '', desc: h.snippet };
    });
    const t = $('idxTitle'); if (t) t.textContent = tr('search.title');
    const c = $('idxCount'); if (c) c.textContent = tr('search.results', { count: mapped.length });
    renderList(mapped);
  }, 200);
};
// Enter → ask your wiki (when semantic search is available).
$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = $('search').value.trim();
  if (q && ragEnabled) doAsk(q);
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if ($('editor').style.display !== 'none') $('saveBtn').click();
  }
});

// ---------- Settings modal (desktop only; backed by Electron IPC) ----------
// window.wikiSettings is injected by desktop/settings-preload.cjs. In a normal
// browser tab it's undefined, so the gear and modal stay hidden.
const SETTING_KEYS = [
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'EMBED_BASE_URL', 'EMBED_API_KEY', 'EMBED_MODEL',
  'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL',
  'S3_ENDPOINT', 'S3_REGION', 'S3_KEY_PREFIX', 'S3_FORCE_PATH_STYLE',
];

function copyMcpValue(elementId, successMessage) {
  const value = $(elementId)?.textContent || '';
  navigator.clipboard.writeText(value.trim())
    .then(() => toast(successMessage))
    .catch(() => toast(tr('copy.failed')));
}

function openMcpModal() {
  closeSettings();
  const localMcpUrl = location.origin + '/mcp';
  $('mcpLocalAddress').textContent = localMcpUrl;
  $('mcpCursorConfig').textContent = JSON.stringify({
    mcpServers: {
      'wikinest-local': { url: localMcpUrl },
    },
  }, null, 2);
  $('mcpClaudeCommand').textContent =
    'claude mcp add --scope user --transport http wikinest-local ' + localMcpUrl;
  $('mcpOverlay').classList.add('show');
}

function closeMcpModal() { $('mcpOverlay').classList.remove('show'); }

function wireMcpModal() {
  const overlay = $('mcpOverlay');
  if (!overlay) return;
  $('mcpClose').onclick = closeMcpModal;
  $('mcpCopyAddress').onclick = () => copyMcpValue('mcpLocalAddress', tr('copy.address'));
  $('mcpCopyCursor').onclick = () => copyMcpValue('mcpCursorConfig', tr('copy.cursor'));
  $('mcpCopyClaude').onclick = () => copyMcpValue('mcpClaudeCommand', tr('copy.claude'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMcpModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeMcpModal();
  });
}

async function openSettings() {
  if (!window.wikiSettings) return;
  closeMcpModal();
  const overlay = $('setOverlay');
  $('setStatus').textContent = '';
  try {
    const data = await window.wikiSettings.get();
    for (const k of SETTING_KEYS) { const el = $(k); if (el) el.value = (data && data[k]) || ''; }
  } catch (e) { /* ignore, show blanks */ }
  try {
    const info = await window.wikiSettings.info();
    $('setVaultPath').textContent = (info && info.vaultDir) || '—';
    $('UI_LOCALE').value = (info && info.locale) || UI_LOCALE;
  } catch (e) { /* ignore */ }
  overlay.classList.add('show');
}

function closeSettings() { $('setOverlay').classList.remove('show'); }

function wireSettings() {
  const overlay = $('setOverlay');
  if (!overlay) return;
  // The settings entry lives in the sidebar footer (see wireSidebar); this
  // function wires the modal itself.
  $('setCancel').onclick = closeSettings;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeSettings();
  });

  $('setChooseVault').onclick = () => {
    if (!window.wikiSettings) return;
    $('setStatus').textContent = tr('settings.vaultRestart');
    window.wikiSettings.chooseVault();
  };

  $('setSave').onclick = async () => {
    if (!window.wikiSettings) return;
    const out = {};
    for (const k of SETTING_KEYS) out[k] = ($(k)?.value || '').trim();
    out.locale = $('UI_LOCALE').value;
    $('setStatus').textContent = tr('settings.saving');
    try {
      // LLM / Embedding / S3 改动会热生效(后端刷新 env),无需重启。
      const result = await window.wikiSettings.save(out);
      if (result && result.localeChanged) {
        location.reload();
        return;
      }
      await refreshFeatureFlags();
      closeSettings();
      toast(tr('toast.settingsSaved'));
    } catch (e) { $('setStatus').textContent = tr('settings.saveFailed', { message: e.message }); }
  };

  // Menu (Cmd/Ctrl+,) and first-run can ask us to open the modal.
  if (window.wikiSettings && window.wikiSettings.onOpenSettings) {
    window.wikiSettings.onOpenSettings(() => openSettings());
  }
  // A settings save (from here or the fallback window) hot-applies on the
  // backend; re-pull capability flags so the UI reflects it immediately.
  if (window.wikiSettings && window.wikiSettings.onSettingsUpdated) {
    window.wikiSettings.onSettingsUpdated((payload) => {
      if (payload && payload.localeChanged) {
        // The in-page save handler reloads after its IPC promise resolves.
        // This branch covers a save from the standalone fallback window.
        if (!$('setOverlay').classList.contains('show')) location.reload();
        return;
      }
      refreshFeatureFlags();
    });
  }
}

// Pull backend capability flags (AI classify / organize / RAG / upload) and
// reflect them in the UI. Runs on load and again after a settings change, so
// toggling AI or storage config takes effect with no restart or page reload.
async function refreshFeatureFlags() {
  const [c, o, r, u] = await Promise.all([
    api('/api/classify/status').catch(() => ({})),
    api('/api/organize/status').catch(() => ({})),
    api('/api/rag/status').catch(() => ({})),
    api('/api/upload/status').catch(() => ({})),
  ]);
  classifyEnabled = !!(c && c.enabled);
  organizeEnabled = !!(o && o.enabled);
  ragEnabled = !!(r && r.enabled);
  uploadEnabled = !!(u && u.enabled);

  // organize (tidy + synthesize) gates
  renderDigestBanner();
  if ($('selectBtn')) $('selectBtn').style.display = organizeEnabled ? '' : 'none';
  // rag (ask) gates
  if ($('askNav')) $('askNav').style.display = ragEnabled ? '' : 'none';
  if ($('cmdKbd')) $('cmdKbd').style.display = ragEnabled ? '' : 'none';
  $('search').placeholder = tr(ragEnabled ? 'toolbar.searchOrAsk' : 'toolbar.search');
}

wireSidebar();
wireMcpModal();
wireSettings();
refreshFeatureFlags();
// Default to shown; honor a remembered "hidden" choice, and start hidden on
// narrow screens where the panel would otherwise cover the content.
try {
  const saved = localStorage.getItem(SIDEBAR_KEY);
  if (saved === '0' || (saved === null && window.innerWidth < 760)) applySidebar(false);
} catch (e) {}
setActiveSide('all');
loadIndex();
</script>
</body>
</html>`;
}

export const PAGE_HTML = renderPage('zh-CN');
