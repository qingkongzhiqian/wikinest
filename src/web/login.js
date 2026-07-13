// Standalone login page. Served at GET /login when a WIKI_PASSWORD is set.
// Self-contained (inline CSS + JS). Mirrors the main SPA (page.js) design
// system: white editorial surface, hairline borders, near-black ink, and a
// pill primary button — the OpenAI "Research" look, so the auth gate feels
// like the same product rather than a separate splash screen.
export const LOGIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>登录 · Wikinest</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #0d0d0d;            /* near-black ink (matches SPA) */
    --muted: #6e6e73;         /* secondary text */
    --faint: #ececec;         /* hairline separators */
    --hover: #f5f5f5;
    --chip: #f0f0f0;
    --danger: #d92d20;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
            "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    --maxw: 1080px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--sans); color: var(--fg); background: var(--bg);
    font-size: 15px; -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; min-height: 100%;
  }

  /* Top bar mirrors the SPA nav so the gate reads as the same app. */
  .topbar { border-bottom: 1px solid var(--faint); }
  .topbar-inner {
    max-width: var(--maxw); margin: 0 auto; padding: 16px 24px;
    display: flex; align-items: center;
  }
  .logo { font-weight: 700; font-size: 17px; letter-spacing: -0.02em; }

  main {
    flex: 1; display: grid; place-items: center; padding: 24px;
  }

  .card {
    width: 100%; max-width: 400px;
    background: var(--bg);
    border: 1px solid var(--faint);
    border-radius: 16px;
    padding: 40px 36px 28px;
    box-shadow: 0 6px 24px rgba(0,0,0,.05);
    animation: rise .5s cubic-bezier(.2,.75,.2,1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } }

  .brand {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    margin-bottom: 30px;
  }
  .mark {
    width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
    background: var(--fg); color: #fff; margin-bottom: 18px;
  }
  .mark svg { width: 26px; height: 26px; }
  .brand h1 { font-size: 27px; font-weight: 600; letter-spacing: -0.03em; margin: 0; }
  .brand p { margin: 9px 0 0; color: var(--muted); font-size: 14.5px; }

  form { display: flex; flex-direction: column; gap: 12px; }
  .field { position: relative; }
  .field .ico {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    color: var(--muted); display: grid; place-items: center; pointer-events: none;
    transition: color .15s;
  }
  .field .ico svg { width: 17px; height: 17px; }
  input[type="text"], input[type="password"] {
    width: 100%; padding: 13px 44px 13px 42px;
    border: 1px solid var(--faint); border-radius: 10px; background: var(--bg);
    font-family: inherit; font-size: 15px; color: var(--fg); outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: #a9a9ae; }
  input:focus {
    border-color: #c7c7c7;
    box-shadow: 0 0 0 3px rgba(13,13,13,.06);
  }
  .field:focus-within .ico { color: var(--fg); }
  .peek {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    width: 32px; height: 32px; border: none; background: none; cursor: pointer;
    color: var(--muted); display: grid; place-items: center; border-radius: 8px;
    transition: color .15s, background .15s;
  }
  .peek svg { width: 18px; height: 18px; }
  .peek:hover { color: var(--fg); background: var(--hover); }
  .peek:focus-visible { outline: 2px solid var(--fg); outline-offset: 1px; }

  button.submit {
    margin-top: 6px; padding: 13px 16px; border: none; border-radius: 999px;
    background: var(--fg); color: #fff; font-family: inherit; font-size: 15px;
    font-weight: 500; cursor: pointer; letter-spacing: .01em;
    transition: opacity .12s, transform .06s;
  }
  button.submit:hover { opacity: .85; }
  button.submit:active { transform: translateY(1px); }
  button.submit:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  button.submit[disabled] { opacity: .55; cursor: default; }

  .err {
    color: var(--danger); font-size: 13.5px; text-align: center; min-height: 18px;
    margin: 2px 0 0;
  }
  .shake { animation: shake .4s; }
  @keyframes shake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-5px); }
    40%, 60% { transform: translateX(5px); }
  }

  .foot {
    margin-top: 22px; text-align: center; color: var(--muted); font-size: 12.5px;
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .foot svg { width: 13px; height: 13px; }

  .spinner {
    width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.4);
    border-top-color: #fff; border-radius: 50%; display: inline-block;
    vertical-align: -3px; margin-right: 8px; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .brand h1 { font-size: 24px; }
    .card { padding: 34px 26px 24px; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner"><span class="logo">Wiki</span></div>
  </header>
  <main>
  <div class="card">
    <div class="brand">
      <div class="mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/>
          <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5z"/>
        </svg>
      </div>
      <h1>Wikinest</h1>
      <p>登录以继续</p>
    </div>
    <form id="loginForm" autocomplete="on">
      <div class="field" id="userField" style="display:none">
        <span class="ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
        </span>
        <input id="user" type="text" name="username" placeholder="用户名" autocomplete="username" />
      </div>
      <div class="field">
        <span class="ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        </span>
        <input id="password" type="password" name="password" placeholder="密码" autocomplete="current-password" autofocus />
        <button type="button" class="peek" id="peek" title="显示/隐藏密码" aria-label="显示或隐藏密码">
          <svg id="eyeOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg id="eyeOff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M10.7 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.5 7.5A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4-.8"/><path d="m4 4 16 16"/></svg>
        </button>
      </div>
      <button type="submit" class="submit" id="submit">登录</button>
      <p class="err" id="err"></p>
    </form>
    <div class="foot">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      受保护的私人知识库
    </div>
  </div>
  </main>

<script>
  var $ = function (id) { return document.getElementById(id); };
  var form = $('loginForm'), errEl = $('err'), submitBtn = $('submit');

  $('peek').addEventListener('click', function () {
    var p = $('password');
    var show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('eyeOpen').style.display = show ? 'none' : '';
    $('eyeOff').style.display = show ? '' : 'none';
    p.focus();
  });

  function safeNext() {
    try {
      var n = new URLSearchParams(location.search).get('next') || '/';
      if (n.charAt(0) === '/' && n.charAt(1) !== '/') return n;
    } catch (e) {}
    return '/';
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    errEl.textContent = '';
    var body = { password: $('password').value };
    var userVal = $('user') ? $('user').value : '';
    if (userVal) body.user = userVal;

    submitBtn.disabled = true;
    var original = submitBtn.textContent;
    submitBtn.innerHTML = '<span class="spinner"></span>登录中…';
    try {
      var r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) { location.assign(safeNext()); return; }
      var data = {};
      try { data = await r.json(); } catch (e) {}
      errEl.textContent = data.error || '登录失败,请重试';
      var card = document.querySelector('.card');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      $('password').select();
    } catch (e) {
      errEl.textContent = '网络错误,请重试';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
</script>
</body>
</html>`;
