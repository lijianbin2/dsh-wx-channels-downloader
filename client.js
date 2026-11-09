/**
 * Client half: one paste box, one button.
 *
 * The panel orchestrates the whole chain (take over the proxy → wait for the
 * Channels page → resolve → download → restore the proxy) so the user only
 * pastes a link. The proxy is never left behind: it is restored on success, on
 * failure, and on cancel.
 */
window.__ModuleLoader__.load({
  id: '@local/wx-channels-downloader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'wx-channels-downloader';
    const RPC = '/api/wx-channels-downloader/rpc';
    const REPO_URL = 'https://github.com/ltaoo/wx_channels_download';
    const RELEASES_URL = REPO_URL + '/releases/latest';
    const AUTO_RESTORE_KEY = 'dsh.wx-channels-downloader.autoRestore';
    const CLOSE_APP_KEY = 'dsh.wx-channels-downloader.closeAfterDownload';
    const UPDATE_CHECK_KEY = 'dsh.wx-channels-downloader.lastUpdateCheck';
    const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const TERMINAL = ['finished', 'failed', 'cancelled'];
    const CHANNELS_WAIT_MS = 300000;

    const CSS = `
.wxdl{--wx-bg:var(--dsw-alias-bg-layer-1,#fff);--wx-soft:var(--dsw-alias-bg-layer-2,#f6f7f8);--wx-text:var(--dsw-alias-label-primary,#181818);--wx-muted:var(--dsw-alias-label-secondary,#6b7280);--wx-border:var(--dsw-alias-border-l1,#e6e8ea);--wx-green:#07c160;--wx-green-dark:#059b4c;--wx-green-soft:rgba(7,193,96,.10);--wx-warn:var(--dsw-alias-state-warn-primary,#8a5a00);--wx-warn-bg:rgba(216,138,0,.08);--wx-err:var(--dsw-alias-state-error-primary,#b43c3c);--wx-ok:var(--dsw-alias-state-success-primary,#24794a);container-type:inline-size;box-sizing:border-box;color:var(--wx-text);font:14px/1.65 var(--dsh-font-family-content,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);min-width:0;max-width:100%;text-align:start}
.wxdl *,.wxdl *::before,.wxdl *::after{box-sizing:border-box}
.wxdl h1,.wxdl h2,.wxdl p,.wxdl dl,.wxdl dd,.wxdl ul,.wxdl ol{margin:0}
.wxdl a{color:var(--wx-green-dark);text-underline-offset:2px}
.wxdl[data-main="true"]{height:100%;min-height:0;overflow:auto;background:var(--wx-bg);padding:calc(18px + var(--dsh-frame-top-clearance,0px)) 28px 44px max(28px,var(--dsh-frame-leading-clearance,0px))}
.wxdl-inner{display:flex;flex-direction:column;gap:18px;max-width:760px;margin:0 auto}
.wxdl-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wxdl-identity{display:flex;align-items:center;gap:13px;min-width:0}
.wxdl h1{font-size:21px;line-height:1.3;font-weight:650;letter-spacing:-.01em}
.wxdl-sub{margin-top:3px!important;color:var(--wx-muted);font-size:12.5px;line-height:1.6}
.wxdl .wxdl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 13px;border:1px solid var(--wx-border);border-radius:9px;background:var(--wx-bg);color:var(--wx-text);font:inherit;font-size:13px;font-weight:500;line-height:1.35;text-decoration:none;cursor:pointer;white-space:nowrap}
.wxdl .wxdl-btn:not(:disabled):hover{background:var(--wx-soft)}
.wxdl .wxdl-btn:disabled{opacity:.45;cursor:not-allowed}
.wxdl .wxdl-btn-primary{background:var(--wx-green);border-color:var(--wx-green);color:#fff}
.wxdl .wxdl-btn-primary:not(:disabled):hover{background:var(--wx-green-dark);border-color:var(--wx-green-dark)}
.wxdl .wxdl-btn-sm{min-height:30px;padding:4px 10px;font-size:12px;border-radius:8px}
.wxdl .wxdl-btn-ghost{border-color:transparent;background:transparent;color:var(--wx-muted)}
.wxdl .wxdl-btn-ghost:not(:disabled):hover{background:var(--wx-soft);color:var(--wx-text)}
.wxdl-main{padding:20px;border:1px solid var(--wx-border);border-radius:14px;background:var(--wx-bg)}
.wxdl-input-row{display:flex;gap:8px;flex-wrap:wrap}
.wxdl .wxdl-input{flex:1 1 300px;min-width:0;min-height:46px;padding:10px 13px;border:1px solid var(--wx-border);border-radius:10px;background:var(--wx-bg);color:var(--wx-text);font:inherit;font-size:13.5px}
.wxdl .wxdl-input:focus-visible{outline:2px solid var(--wx-green);outline-offset:1px}
.wxdl .wxdl-input:disabled{opacity:.6}
.wxdl .wxdl-go{min-height:46px;padding:0 22px;border-radius:10px;font-size:14px;font-weight:600}
.wxdl-state{display:flex;gap:10px;align-items:flex-start;margin-top:14px;padding:12px 14px;border-radius:10px;border:1px solid var(--wx-border);background:var(--wx-soft);font-size:13px;line-height:1.65;overflow-wrap:anywhere}
.wxdl-state[data-tone="ok"]{border-color:rgba(7,193,96,.35);background:var(--wx-green-soft);color:var(--wx-green-dark)}
.wxdl-state[data-tone="warn"]{border-color:rgba(216,138,0,.4);background:var(--wx-warn-bg);color:var(--wx-warn)}
.wxdl-state[data-tone="bad"]{border-color:rgba(180,60,60,.35);background:rgba(180,60,60,.07);color:var(--wx-err)}
.wxdl-state>svg{flex-shrink:0;margin-top:3px}
.wxdl-state-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:8px}
.wxdl-state-actions{display:flex;gap:8px;flex-wrap:wrap}
.wxdl-bar{height:6px;border-radius:3px;background:rgba(0,0,0,.07);overflow:hidden}
.wxdl-bar>i{display:block;height:100%;background:var(--wx-green);border-radius:3px;transition:width .3s ease}
.wxdl-dir-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--wx-muted);min-width:0}
.wxdl-dir-row>span{flex:0 0 auto}
.wxdl-dir-row>code{flex:1 1 200px;min-width:0;padding:2px 7px;border-radius:6px;background:var(--wx-soft);color:var(--wx-text);font:12px/1.6 ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}
.wxdl-preview{display:flex;gap:12px;margin-top:14px;padding:12px;border:1px solid var(--wx-border);border-radius:10px;min-width:0}
.wxdl-cover{width:104px;height:58px;flex:0 0 auto;border-radius:7px;object-fit:cover;background:var(--wx-soft)}
.wxdl-cover-empty{display:flex;align-items:center;justify-content:center;color:var(--wx-muted)}
.wxdl-preview-body{min-width:0;display:flex;flex-direction:column;gap:3px}
.wxdl-preview-title{font-size:13px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
.wxdl-preview-meta{color:var(--wx-muted);font-size:12px}
.wxdl-advanced{border-top:1px solid var(--wx-border);padding-top:14px}
.wxdl-advanced summary{display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12.5px;color:var(--wx-muted);list-style:none}
.wxdl-advanced summary::-webkit-details-marker{display:none}
.wxdl-advanced summary::after{content:"";width:6px;height:6px;margin-inline-start:auto;border-inline-end:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg);transition:transform .15s}
.wxdl-advanced[open] summary::after{transform:rotate(225deg)}
.wxdl-advanced-body{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.wxdl-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;font-size:12.5px;min-width:0}
.wxdl-row dt{color:var(--wx-muted);flex-shrink:0}
.wxdl-row dd{text-align:end;font-weight:500;overflow-wrap:anywhere;min-width:0}
.wxdl-advanced-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.wxdl-switch{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;cursor:pointer;user-select:none;margin-top:10px}
.wxdl-switch input{position:absolute;opacity:0;width:1px;height:1px}
.wxdl-switch i{width:32px;height:19px;border-radius:10px;background:var(--wx-border);position:relative;transition:background .15s;flex:0 0 auto}
.wxdl-switch i::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.wxdl-switch input:checked+i{background:var(--wx-green)}
.wxdl-switch input:checked+i::after{transform:translateX(13px)}
.wxdl-foot{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;justify-content:space-between;color:var(--wx-muted);font-size:11.5px;line-height:1.6}
.wxdl-foot a{font-size:11.5px}
.wxdl-settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--wx-muted)}
.wxdl-settings .wxdl-input{min-height:32px;font-size:12px;flex:1 1 220px}
@keyframes wxdl-spin{to{transform:rotate(360deg)}}
.wxdl-spin{animation:wxdl-spin 1s linear infinite}
@media (max-width:700px){.wxdl[data-main="true"]{padding:calc(16px + var(--dsh-frame-top-clearance,0px)) 16px 32px max(16px,var(--dsh-frame-leading-clearance,0px))}.wxdl .wxdl-go{flex:1 1 100%}.wxdl-cover{width:80px;height:45px}}
`;

    function Styles() {
      return h('style', null, CSS);
    }

    function LogoMark({ size = 46 }) {
      const id = React.useId ? React.useId() : 'wxdl-logo';
      return h('svg', {
        width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: 'false',
        style: { flexShrink: 0, borderRadius: Math.round(size * 0.25), boxShadow: '0 6px 18px rgba(7,193,96,.24)' },
      },
      h('defs', null, h('linearGradient', { id, x1: 6, y1: 4, x2: 58, y2: 60, gradientUnits: 'userSpaceOnUse' },
        h('stop', { stopColor: '#22CE6E' }), h('stop', { offset: 1, stopColor: '#059B4C' }))),
      h('rect', { width: 64, height: 64, rx: 16, fill: 'url(#' + id + ')' }),
      h('path', { d: 'M32 14v21', fill: 'none', stroke: '#fff', strokeWidth: 5.5, strokeLinecap: 'round' }),
      h('path', { d: 'M23 27.5 32 36.5l9-9', fill: 'none', stroke: '#fff', strokeWidth: 5.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M17.5 45.5h29', fill: 'none', stroke: '#fff', strokeWidth: 5.5, strokeLinecap: 'round' }));
    }

    function SidebarIcon({ size }) {
      const px = typeof size === 'number' ? size : 18;
      return h('svg', {
        viewBox: '0 0 20 20', width: px, height: px, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      },
      h('path', { d: 'M10 3.4v8.2' }),
      h('path', { d: 'M6.5 8.3 10 11.8l3.5-3.5' }),
      h('path', { d: 'M4.6 15.2h10.8' }));
    }

    const GLYPHS = {
      download: [['M8 2.6v6.6'], ['M5.4 6.6 8 9.2l2.6-2.6'], ['M3.4 12.6h9.2']],
      refresh: [['M13 8a5 5 0 1 1-1.6-3.7'], ['M13 2.8v3.2H9.8']],
      warning: [['M8 2.4 14.2 13H1.8L8 2.4Z'], ['M8 6.4v3.1'], ['M8 11.6h.01']],
      check: [['M3.6 8.4 6.4 11.2l6-6']],
      folder: [['M2.6 5.2h4l1.2 1.5h5.6v6.1H2.6V5.2Z']],
      shield: [['M8 2.4l4.6 1.8v3.4c0 2.5-1.8 4.6-4.6 5.4-2.8-.8-4.6-2.9-4.6-5.4V4.2L8 2.4Z'], ['M6 8.1l1.5 1.5L10.4 6.7']],
      spinner: [['M8 1.8a6.2 6.2 0 1 1-6.2 6.2']],
    };

    function Glyph({ name, size = 16, spin = false }) {
      const paths = GLYPHS[name];
      if (!paths) return null;
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: spin ? 'wxdl-spin' : undefined,
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      }, paths.map((d, index) => h('path', { key: index, d: d[0] })));
    }

    const RPC_TIMEOUTS = {
      'app.ensure': 20000,
      'app.update': 240000,
      'app.start': 60000,
      'app.restart': 120000,
      'wechat.restart': 60000,
      'dir.pick': 185000,
      'app.detect': 30000,
      'proxy.start': 20000,
      'proxy.stop': 40000,
      resolve: 40000,
      download: 60000,
    };

    async function rpc(action, payload) {
      const timeout = RPC_TIMEOUTS[action] ?? 20000;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
      let response;
      try {
        response = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, payload: payload ?? {} }),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
        });
      } catch (error) {
        const failure = new Error(error?.name === 'AbortError' ? '宿主没有及时响应（请求超时）' : 'RPC_UNREACHABLE');
        failure.code = error?.name === 'AbortError' ? 'rpc-timeout' : 'rpc-unreachable';
        throw failure;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!data) {
        const error = new Error('RPC_UNREACHABLE');
        error.code = 'rpc-unreachable';
        throw error;
      }
      if (!data.ok) {
        const error = new Error(data.error?.message || '请求失败');
        error.code = data.error?.code || 'unknown';
        throw error;
      }
      return data.data;
    }

    /** WeChat Channels share links only (sph short links / channels pages). */
    function isChannelsLink(value) {
      return /^https?:\/\/(weixin\.qq\.com\/sph\/[A-Za-z0-9_-]+|channels\.weixin\.qq\.com\/\S+)/i.test(String(value || '').trim());
    }

    function formatBytes(value) {
      const bytes = Number(value) || 0;
      if (!bytes) return '';
      if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
      if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
      if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return bytes + ' B';
    }

    function readAutoRestore() {
      try {
        return window.localStorage.getItem(AUTO_RESTORE_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    function writeAutoRestore(value) {
      try {
        window.localStorage.setItem(AUTO_RESTORE_KEY, value ? 'on' : 'off');
      } catch {
        /* ignore */
      }
    }

    function readCloseAfterDownload() {
      try {
        return window.localStorage.getItem(CLOSE_APP_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    function writeCloseAfterDownload(value) {
      try {
        window.localStorage.setItem(CLOSE_APP_KEY, value ? 'on' : 'off');
      } catch {
        /* ignore */
      }
    }

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const currentLocale = () => String(ctx.locale?.getSnapshot?.().active || '');

        function useLocale() {
          const [active, setActive] = React.useState(currentLocale);
          React.useEffect(() => {
            if (typeof ctx.locale?.subscribe !== 'function') return undefined;
            const off = ctx.locale.subscribe(() => setActive(currentLocale()));
            return typeof off === 'function' ? off : undefined;
          }, []);
          const fallback = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
          return /^zh/i.test(active || fallback) ? 'zh' : 'en';
        }

        function Panel({ workbench }) {
          const lang = useLocale();
          const zh = lang === 'zh';
          const t = (zhText, enText) => (zh ? zhText : enText);

          const [state, setState] = React.useState(null);
          const [bootError, setBootError] = React.useState(null);
          const [link, setLink] = React.useState('');
          const [stage, setStage] = React.useState('idle');
          const [hint, setHint] = React.useState(null);
          const [result, setResult] = React.useState(null);
          const [preview, setPreview] = React.useState(null);
          const [progress, setProgress] = React.useState(0);
          const [autoRestore, setAutoRestore] = React.useState(readAutoRestore);
          const [closeAfterDownload, setCloseAfterDownload] = React.useState(readCloseAfterDownload);
          const [apiDraft, setApiDraft] = React.useState('');
          const [editingApi, setEditingApi] = React.useState(false);
          const [editingDir, setEditingDir] = React.useState(false);
          const [dirDraft, setDirDraft] = React.useState('');
          const [unguarded, setUnguarded] = React.useState(false);
          const [appBusy, setAppBusy] = React.useState(false);
          const [pathDraft, setPathDraft] = React.useState('');
          const [pickingPath, setPickingPath] = React.useState(false);
          const [wedged, setWedged] = React.useState(false);

          const cancelRef = React.useRef(false);
          const aliveRef = React.useRef(true);
          const autoRestoreRef = React.useRef(autoRestore);
          const closeRef = React.useRef(closeAfterDownload);
          const flowIdRef = React.useRef(0);
          autoRestoreRef.current = autoRestore;
          closeRef.current = closeAfterDownload;

          React.useEffect(() => () => { aliveRef.current = false; cancelRef.current = true; }, []);

          const refreshState = React.useCallback(async () => {
            try {
              const next = await rpc('state');
              if (!aliveRef.current) return next;
              setState(next);
              setBootError(null);
              return next;
            } catch (error) {
              if (aliveRef.current) setBootError(error);
              return null;
            }
          }, []);

          React.useEffect(() => {
            refreshState();
          }, [refreshState]);

          // Keep the downloader current without ever blocking the UI: at most one
          // background check per day, and only while the downloader is idle.
          React.useEffect(() => {
            let last = 0;
            try {
              last = Number(window.localStorage.getItem(UPDATE_CHECK_KEY) || 0);
            } catch {
              last = 0;
            }
            if (Date.now() - last < UPDATE_INTERVAL_MS) return undefined;
            const timer = window.setTimeout(() => {
              try {
                window.localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
              } catch {
                /* ignore */
              }
              rpc('app.update').catch(() => undefined);
            }, 8000);
            return () => window.clearTimeout(timer);
          }, []);

          // Pull the newest copied link into the box; Ctrl+C in WeChat is enough.
          const busyRef = React.useRef(false);
          busyRef.current = stage !== 'idle' && stage !== 'ready' && stage !== 'done';

          React.useEffect(() => {
            let cancelled = false;
            async function pull() {
              if (cancelled || busyRef.current) return;
              let text = '';
              try {
                if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                  text = await navigator.clipboard.readText();
                }
              } catch {
                text = '';
              }
              if (!text) {
                try {
                  const data = await rpc('clipboard.read');
                  text = String(data?.text || '');
                } catch {
                  text = '';
                }
              }
              const value = String(text || '').trim();
              // Only Channels share links: a random copied URL must never be filled in.
              if (cancelled || !isChannelsLink(value)) return;
              setLink(previous => (previous.trim() === value ? previous : value));
            }
            pull();
            window.addEventListener('focus', pull);
            return () => {
              cancelled = true;
              window.removeEventListener('focus', pull);
            };
          }, []);


          const restoreProxy = React.useCallback(async () => {
            try {
              const data = await rpc('proxy.stop');
              if (!aliveRef.current) return data;
              await refreshState();
              return data;
            } catch (error) {
              return { restored: false, error };
            }
          }, [refreshState]);

          async function waitForTask(id) {
            while (!cancelRef.current) {
              const data = await rpc('tasks', { ids: [id] });
              const task = data?.tasks?.[0];
              if (!aliveRef.current) return task || null;
              if (task) {
                setProgress(typeof task.progress === 'number' ? task.progress : 0);
                if (TERMINAL.includes(task.status)) return task;
              }
              await sleep(1200);
            }
            return null;
          }

          /** Resolve a link: start the downloader, reach the Channels page, read the title. */
          /**
           * Resolve a link. If the Channels page is not connected we say so once and
           * leave the proxy in place, so the user can reopen Channels and press
           * Download again — no polling, no buttons of ours to press.
           */
          async function resolveLink(value) {
            let current = await refreshState();
            if (!current) throw new Error(t('读取不到插件状态', 'Cannot read plugin state'));
            if (!current.tool?.running) {
              current = await ensureAndStart();
              if (!current?.tool?.running) throw new Error(t('下载器没起来，再点一次试试', 'The downloader is not up — try again'));
            }

            if (!current.tool?.channels?.available) {
              // A freshly started downloader needs a few seconds before the open
              // Channels page reconnects its websocket, so wait briefly first.
              const deadline = Date.now() + 9000;
              while (Date.now() < deadline && !current.tool?.channels?.available) {
                await sleep(800);
                if (!aliveRef.current) return null;
                const next = await refreshState();
                if (next) current = next;
              }
            }

            if (!current.tool?.channels?.available) {
              if (!current.session?.active) {
                try {
                  await rpc('proxy.start');
                } catch (error) {
                  if (error.code === 'proxy-offline' || error.code === 'unsupported-platform') throw error;
                }
              }
              const error = new Error(t(
                '视频号页面还没连上。代理已开启：请在微信里重新打开一次「视频号」（或退出微信再打开），然后回来重新点「下载」。',
                'The Channels page is not connected yet. The proxy is on: reopen Channels in WeChat (or restart WeChat), then press Download again.',
              ));
              error.code = 'channels-offline';
              throw error;
            }

            setStage('resolving');
            try {
              return await rpc('resolve', { url: value });
            } catch (error) {
              // The downloader may have been closed right after the last download.
              if (error?.code !== 'tool-offline') throw error;
              const again = await ensureAndStart();
              if (!again?.tool?.running) throw error;
              return await rpc('resolve', { url: value });
            }
          }
          async function runFlow() {
            const flowId = ++flowIdRef.current;
            const value = link.trim();
            if (!value) {
              setHint({ tone: 'warn', text: t('先把视频号链接粘贴进来', 'Paste a Channels link first') });
              return;
            }
            cancelRef.current = false;
            setHint(null);
            setResult(null);
            setProgress(0);
            setPreview(null);
            setStage('working');

            let completed = false;
            try {
              const fresh = await resolveLink(value);
              if (!aliveRef.current) return;
              const resolved = { ...fresh, url: value };
              setPreview(resolved);

              setStage('downloading');
              const created = await rpc('download', { object: resolved.object, title: resolved.title, downloadDir: state?.settings?.downloadDir || '' });
              const id = created?.tasks?.[0]?.id;
              if (!id) throw new Error(t('下载器没有返回任务', 'The downloader returned no task'));
              setProgress(0);
              const task = await waitForTask(id);
              if (!aliveRef.current) return;
              if (!task) {
                setStage('idle');
                return;
              }
              if (task.status === 'finished' && task.exists === false) {
                throw new Error(t('下载器说完成了，但磁盘上找不到文件（可能被清理工具删掉了）。请检查杀毒/清理软件后重试。', 'Finished, but the file is not on disk — something may be cleaning it up.'));
              }
              if (task.status === 'finished') {
                setResult({ path: task.path || task.dir || '', name: task.name });
                setStage('done');
                setHint(null);
                completed = true;
                // Update checks touch the network, so they run after everything else.
                window.setTimeout(() => { rpc('app.update').catch(() => undefined); }, 4000);
              } else {
                throw new Error(task.error || (task.status === 'cancelled' ? t('任务被取消', 'The task was cancelled') : t('下载失败', 'The download failed')));
              }
            } catch (error) {
              if (!aliveRef.current) return;
              if (error?.code === 'rpc-unreachable') {
                setHint({ tone: 'bad', text: t('插件宿主还没加载，请重启一次 DSH。', 'Restart DSH once to load the updated plugin host.') });
              } else if (error?.code === 'channels-offline') {
                setHint({ tone: 'warn', text: error.message });
              } else {
                setHint({ tone: 'bad', text: error?.message || t('出错了', 'Something went wrong') });
              }
              setStage('idle');
            } finally {
              if (!aliveRef.current) return;
              if (completed && closeRef.current && flowId === flowIdRef.current) await rpc('app.scheduleClose', { minutes: 5 }).catch(() => undefined);
            }
          }

          /** Nothing should stay resident: stop the downloader once the work is done. */
          async function closeTool() {
            try {
              // Never stop the downloader while the system proxy still points at it:
              // WeChat's built-in browser would then fail with ERR_PROXY_CONNECTION_FAILED.
              if (state?.session?.active) await rpc('proxy.stop').catch(() => undefined);
              const data = await rpc('app.stop');
              if (data?.needsElevation && aliveRef.current) {
                setHint({
                  tone: 'warn',
                  text: t('下载完成，但下载器是管理员权限启动的，我关不掉它——把那个命令行窗口关掉一次，之后我就能自动关。',
                    'Downloaded, but the downloader runs as administrator so I cannot stop it. Close its console once and I can handle it from then on.'),
                });
              }
              return data;
            } catch (error) {
              return { stopped: false, error: error?.message };
            }
          }

          async function manualRestore() {
            cancelRef.current = true;
            const data = await restoreProxy();
            if (!aliveRef.current) return;
            if (data?.reason === 'changed-by-other') setUnguarded(true);
            setStage('idle');
            setHint(data?.restored
              ? { tone: 'ok', text: t('系统代理已还原到你原来的设置', 'Your previous proxy settings are restored') }
              : { tone: 'warn', text: t('没有需要还原的代理记录', 'Nothing to restore') });
          }

          async function saveApi() {
            try {
              const data = await rpc('settings', { apiBase: apiDraft });
              setEditingApi(false);
              setState(previous => (previous ? { ...previous, settings: data.settings } : previous));
              await refreshState();
            } catch (error) {
              if (aliveRef.current) setHint({ tone: 'bad', text: error.message });
            }
          }

          async function waitUntilRunning(ms) {
            const started = Date.now();
            while (Date.now() - started < ms) {
              await sleep(1000);
              const next = await refreshState();
              if (next?.tool?.running) return next;
            }
            return null;
          }

          async function launchApp(path) {
            setAppBusy(true);
            setHint({ tone: '', text: t('正在启动下载器…如果系统弹了 UAC，请点允许', 'Starting the downloader — allow it if Windows asks') });
            try {
              await rpc('app.start', path ? { path } : {});
              setPickingPath(false);
              const live = await waitUntilRunning(25000);
              if (!live) setHint({ tone: 'bad', text: t('没等到下载器起来。它可能需要手动以管理员身份启动一次。', 'The downloader did not come up. It may need a manual administrator start.') });
              else setHint({ tone: 'ok', text: t('下载器已启动，现在可以粘贴链接了', 'Downloader is up — paste a link') });
            } catch (error) {
              if (error.code === 'no-app-path' || error.code === 'bad-app-path') {
                setPickingPath(true);
                setPathDraft('');
                setHint({ tone: 'warn', text: error.message });
              } else {
                setHint({ tone: 'bad', text: error.message });
              }
            } finally {
              if (aliveRef.current) setAppBusy(false);
            }
          }

          async function detectAndLaunch() {
            setAppBusy(true);
            setHint(null);
            try {
              const data = await rpc('app.detect');
              const found = Array.isArray(data?.found) ? data.found : [];
              if (found.length) {
                setAppBusy(false);
                await launchApp(data.chosen || found[0]);
                return;
              }
              setPickingPath(true);
              setPathDraft('');
            } catch (error) {
              setHint({ tone: 'bad', text: error.message });
            } finally {
              if (aliveRef.current) setAppBusy(false);
            }
          }

          /** Install/update if needed, then start it. Returns the live state or null. */
          async function ensureAndStart() {
            setAppBusy(true);
            setStage('preparing');

            try {
              let info = null;
              try {
                info = await rpc('app.ensure');
              } catch (error) {
                info = { action: 'ensure-failed', error: error.message };
              }
              if (info?.action === 'missing') {
                // No local build at all: this is the only path that needs the network.
                setHint({ tone: '', text: t('还没有下载器，正在下载安装（约 15 MB）…', 'Downloading the downloader (about 15 MB)…') });
                try {
                  info = await rpc('app.update');
                } catch (error) {
                  info = { action: 'ensure-failed', error: error.message };
                }
              }
              if (info?.action === 'installed' || info?.action === 'updated') {
                setHint({ tone: 'ok', text: t(`下载器已${info.action === 'updated' ? '更新' : '安装'}到 ${info.version}`, `Downloader ${info.action === 'updated' ? 'updated' : 'installed'} (${info.version})`) });
              } else if (info?.action === 'offline-installed' && info.error) {
                setHint({ tone: 'warn', text: t('检查更新没成功（网络问题），先用现有版本继续', 'Could not check for updates — using the installed build') });
              } else if (info?.action === 'ensure-failed') {
                setHint({ tone: 'warn', text: info.error || t('检查更新失败，先用现有版本继续', 'Update check failed, continuing with the installed build') });
              }
              if (info?.appPath) setState(previous => (previous ? { ...previous, settings: { ...previous.settings, appPath: info.appPath } } : previous));
              setStage('working');
              try {
                const startInfo = await rpc('app.start', info?.appPath ? { path: info.appPath } : {});
                if (startInfo?.alreadyRunning) setWedged(false);
              } catch (startError) {
                if (startError.code === 'tool-unresponsive') {
                  setWedged(true);
                  setHint({ tone: 'bad', text: startError.message });
                  return null;
                }
                throw startError;
              }
              const live = await waitUntilRunning(45000);
              if (!live) {
                setHint({ tone: 'bad', text: t('下载器没能启动。请手动右键「以管理员身份运行」它一次，然后点刷新。', 'The downloader did not start. Run it once as administrator, then refresh.') });
              }
              return live;
            } catch (error) {
              if (error.code === 'no-app-path' || error.code === 'bad-app-path') {
                setPickingPath(true);
                setHint({ tone: 'warn', text: t('需要你指定下载器的位置：点「启动」按钮后它也会自动再找一次', 'Point me at the downloader executable') });
              } else if (error.code === 'download-failed' || error.code === 'release-unavailable' || error.code === 'download-timeout') {
                setPickingPath(true);
                setHint({ tone: 'bad', text: `${error.message}。可以从 Releases 手动下载 windows 包解压后，把 exe 路径填进来。` });
              } else {
                setHint({ tone: 'bad', text: error.message });
              }
              return null;
            } finally {
              if (aliveRef.current) {
                setAppBusy(false);
                setStage(previous => (previous === 'preparing' ? 'idle' : previous));
              }
            }
          }

          async function checkUpdate() {
            setAppBusy(true);
            setHint({ tone: '', text: t('正在检查更新…', 'Checking for updates…') });
            try {
              const info = await rpc('app.update');
              if (info?.action === 'updated' || info?.action === 'installed') {
                setHint({ tone: 'ok', text: t(`已更新到 ${info.version}，下次启动生效`, `Updated to ${info.version} — it applies on the next start`) });
                await refreshState();
              } else if (info?.action === 'up-to-date') {
                setHint({ tone: 'ok', text: t(`已是最新版本 ${info.version || info.latest}`, `Already up to date (${info.version || info.latest})`) });
              } else if (info?.action === 'installed-unknown') {
                setHint({ tone: 'warn', text: t(`本地已有的构建版本未知，最新是 ${info.latest}。启动一次后我就能记下版本。`, `Local build version unknown; latest is ${info.latest}`) });
              } else if (info?.error) {
                setHint({ tone: 'warn', text: info.error });
              } else {
                setHint({ tone: 'warn', text: t('没有拿到版本信息', 'No version information') });
              }
            } catch (error) {
              setHint({ tone: 'bad', text: error.message });
            } finally {
              if (aliveRef.current) setAppBusy(false);
            }
          }

          function resolveDirectoryPicker() {
            const candidates = [];
            try {
              if (typeof ctx.get === 'function') candidates.push(ctx.get('uiWorkspace'));
            } catch {
              /* service lookup can throw when it is not mounted */
            }
            try {
              candidates.push(ctx.uiWorkspace);
            } catch {
              /* ignore */
            }
            return candidates.find(item => item && typeof item.pickDirectory === 'function') || null;
          }

          function editDownloadDirManually() {
            setDirDraft(state?.settings?.downloadDir || '');
            setEditingDir(true);
          }

          /** Native shell dialog first; the in-app service and typing are fallbacks. */
          async function pickDownloadDir() {
            setAppBusy(true);
            try {
              const chosen = await rpc('dir.pick');
              if (chosen?.path) {
                const data = await rpc('settings', { downloadDir: chosen.path });
                setState(previous => (previous ? { ...previous, settings: { ...previous.settings, ...data.settings } } : previous));
                setHint({ tone: 'ok', text: t(`以后都下载到 ${chosen.path}`, `Saving to ${chosen.path}`) });
              }
              return;
            } catch (error) {
              setHint({ tone: 'warn', text: error.message });
            } finally {
              if (aliveRef.current) setAppBusy(false);
            }

            const picker = resolveDirectoryPicker();
            if (!picker) {
              editDownloadDirManually();
              return;
            }
            try {
              const picked = await picker.pickDirectory();
              if (!picked) return;
              const data = await rpc('settings', { downloadDir: picked });
              setState(previous => (previous ? { ...previous, settings: { ...previous.settings, ...data.settings } } : previous));
              setHint({ tone: 'ok', text: t(`以后都下载到 ${picked}`, `Saving to ${picked}`) });
            } catch {
              editDownloadDirManually();
            }
          }

          async function saveDownloadDir() {
            const value = dirDraft.trim();
            if (!value) return;
            try {
              const data = await rpc('settings', { downloadDir: value });
              setState(previous => (previous ? { ...previous, settings: { ...previous.settings, ...data.settings } } : previous));
              setEditingDir(false);
              setHint({ tone: 'ok', text: t(`以后都下载到 ${data.settings.downloadDir}`, `Saving to ${data.settings.downloadDir}`) });
            } catch (error) {
              setHint({ tone: 'bad', text: error.message });
            }
          }

          const running = Boolean(state?.tool?.running);
          const channelsReady = Boolean(state?.tool?.channels?.available);
          const proxyActive = Boolean(state?.session?.active);
          const busy = stage === 'preparing' || stage === 'working' || stage === 'resolving' || stage === 'downloading';

          /** Lighter than restarting WeChat: reset its webview so Channels reloads. */
          async function restartDownloader() {
            setAppBusy(true);
            setHint({ tone: '', text: t('正在重启下载器…会弹一次 UAC，请点允许', 'Restarting the downloader — allow the UAC prompt') });
            try {
              await rpc('app.restart');
              const live = await waitUntilRunning(60000);
              if (live?.tool?.running) {
                setWedged(false);
                setHint({ tone: 'ok', text: t('下载器已重启，可以继续了', 'Downloader restarted') });
              } else {
                setHint({ tone: 'bad', text: t('重启后接口还是没响应。把那个命令行窗口关掉，再点一次「重启下载器」。', 'Still no response — close the console window and try again') });
              }
            } catch (error) {
              setHint({ tone: 'bad', text: error.message });
            } finally {
              if (aliveRef.current) setAppBusy(false);
            }
          }

          const hostMissing = bootError?.code === 'rpc-unreachable';

          const status = (() => {
            if (hostMissing) return { tone: 'bad', icon: 'warning', text: t('插件宿主还没加载：请重启一次 DSH。', 'The plugin host is not loaded yet: restart DSH once.') };
            if (stage === 'done') return { tone: 'ok', icon: 'check', text: null };
            if (stage === 'preparing') return { tone: '', icon: 'spinner', text: t('正在后台准备下载器（不会开窗口）…', 'Preparing the downloader in the background…') };
            if (stage === 'downloading') return { tone: '', icon: 'spinner', text: t('正在下载…', 'Downloading…') };
            if (stage === 'resolving') return { tone: '', icon: 'spinner', text: t('正在解析链接…', 'Resolving the link…') };
            if (stage === 'working') return { tone: '', icon: 'spinner', text: t('准备中…', 'Preparing…') };
            if (!state) return { tone: '', icon: 'spinner', text: t('读取状态…', 'Reading status…') };
            if (!running && pickingPath) return { tone: 'warn', icon: 'warning', text: t('没自动找到下载器。把它 .exe 的完整路径贴进来，例如 D:\\Software\\wx_video_download\\wx_video_download.exe', 'Downloader not found automatically. Paste its full .exe path.') };
            if (!running && state?.settings?.appPath) return { tone: '', icon: 'download', text: t('准备就绪。点「下载」会在后台启动下载器（无窗口），完成后自动关闭并还原系统代理。', 'Ready. Download starts the downloader in the background (no window), then closes it and restores the proxy.') };
            if (!running) return { tone: 'bad', icon: 'warning', text: t('还没装下载器。点「下载」我会自动下载安装它。', 'The downloader is not installed yet — downloading installs it.') };
            return { tone: '', icon: 'download', text: t('粘贴微信里的视频号链接，点下载就行。代理只在下载期间接管，结束自动还原。', 'Paste a Channels link and hit Download. The proxy is only taken over while downloading, then restored.') };
          })();

          return h('section', { className: 'wxdl', 'data-main': workbench ? 'true' : 'false' },
            h(Styles, { key: 'styles' }),
            h('div', { className: 'wxdl-inner' },
              h('header', { className: 'wxdl-head' },
                h('div', { className: 'wxdl-identity' },
                  h(LogoMark, { size: 46 }),
                  h('div', null,
                    h('h1', null, t('视频号下载器', 'Channels downloader')),
                    h('p', { className: 'wxdl-sub' }, t('贴链接 → 点下载 → 全自动，代理会自动还原', 'Paste, click, done — the proxy restores itself')))),
                h('div', { style: { display: 'flex', gap: '8px' } },
                  h('button', {
                    type: 'button', className: 'wxdl-btn wxdl-btn-sm', disabled: busy,
                    onClick: () => { setBootError(null); refreshState(); },
                  }, h(Glyph, { name: 'refresh' }), t('刷新', 'Refresh')))),

              h('div', { className: 'wxdl-main' },
                h('div', { className: 'wxdl-input-row' },
                  h('input', {
                    className: 'wxdl-input', type: 'url', inputMode: 'url', spellCheck: false,
                    disabled: busy,
                    value: link,
                    onChange: event => setLink(event.target.value),
                    onKeyDown: event => { if (event.key === 'Enter' && !busy) runFlow(); },
                  }),
                  h('button', {
                    type: 'button', className: 'wxdl-btn wxdl-btn-primary wxdl-go',
                    disabled: busy || !link.trim(),
                    onClick: runFlow,
                  }, busy ? h(Glyph, { name: 'spinner', spin: true }) : h(Glyph, { name: 'download' }),
                  busy ? t('处理中…', 'Working…') : t('下载', 'Download'))),

                editingDir
                  ? h('div', { className: 'wxdl-dir-row' },
                    h('span', null, t('保存到', 'Save to')),
                    h('input', {
                      className: 'wxdl-input', style: { minHeight: '32px', fontSize: '12px', flex: '1 1 260px' },
                      value: dirDraft, spellCheck: false,
                      placeholder: 'D:\\微信视频下载',
                      onChange: event => setDirDraft(event.target.value),
                      onKeyDown: event => { if (event.key === 'Enter') saveDownloadDir(); },
                    }),
                    h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: saveDownloadDir }, t('保存', 'Save')),
                    h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: () => setEditingDir(false) }, t('取消', 'Cancel')))
                  : h('div', { className: 'wxdl-dir-row' },
                    h('span', null, t('保存到', 'Save to')),
                    h('code', { title: state?.settings?.downloadDir || '' }, state?.settings?.downloadDir || t('读取中…', 'loading…')),
                    h('button', {
                      type: 'button', className: 'wxdl-btn wxdl-btn-sm', disabled: busy, onClick: pickDownloadDir,
                    }, h(Glyph, { name: 'folder' }), t('更改', 'Change')),
                    h('button', {
                      type: 'button', className: 'wxdl-btn wxdl-btn-sm wxdl-btn-ghost', disabled: busy, onClick: editDownloadDirManually,
                      title: t('直接输入路径', 'Type the path'),
                    }, t('手填', 'Type'))),

                status.text
                  ? h('div', { className: 'wxdl-state', 'data-tone': status.tone, role: status.tone === 'bad' ? 'alert' : 'status' },
                    h(Glyph, { name: status.icon, spin: status.icon === 'spinner' }),
                    h('div', { className: 'wxdl-state-body' },
                      h('span', null, status.text),
                      stage === 'downloading' ? h('div', { className: 'wxdl-bar' }, h('i', { style: { width: Math.max(2, progress) + '%' } })) : null,
                      stage === 'resolving' || stage === 'downloading'
                        ? h('div', { className: 'wxdl-state-actions' },
                          h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: () => { cancelRef.current = true; setStage('idle'); setHint({ tone: 'warn', text: t('已取消，代理正在还原…', 'Cancelled — restoring the proxy…') }); manualRestore(); } },
                            t('取消', 'Cancel')))
                        : null,
                      !running && state && !busy && !hostMissing && !state?.settings?.appPath
                        ? h('div', { className: 'wxdl-state-actions' },
                          wedged
                            ? h(React.Fragment, null,
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm wxdl-btn-primary',
                                disabled: appBusy,
                                onClick: restartDownloader,
                              }, h(Glyph, { name: 'refresh', spin: appBusy }), appBusy ? t('重启中…', 'Restarting…') : t('重启下载器', 'Restart downloader')),
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm',
                                onClick: () => { setWedged(false); setPickingPath(false); },
                              }, t('忽略', 'Dismiss')))
                            : pickingPath
                            ? h(React.Fragment, null,
                              h('input', {
                                className: 'wxdl-input', style: { minHeight: '32px', fontSize: '12px', flex: '1 1 240px' },
                                placeholder: t('例如 C:\\Users\\你\\Downloads\\wx_video_download.exe', 'e.g. C:\\Users\\you\\Downloads\\wx_video_download.exe'),
                                value: pathDraft, spellCheck: false,
                                onChange: event => setPathDraft(event.target.value),
                                onKeyDown: event => { if (event.key === 'Enter' && pathDraft.trim()) launchApp(pathDraft.trim()); },
                              }),
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm',
                                disabled: appBusy || !pathDraft.trim(),
                                onClick: () => launchApp(pathDraft.trim()),
                              }, t('用这个启动', 'Start this one')),
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm',
                                disabled: appBusy,
                                onClick: detectAndLaunch,
                              }, t('自动查找', 'Find it')))
                            : h(React.Fragment, null,
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm wxdl-btn-primary',
                                disabled: appBusy,
                                onClick: async () => {
                                  const live = await ensureAndStart();
                                  if (!live?.tool?.running && !pickingPath) await detectAndLaunch();
                                },
                              }, h(Glyph, { name: 'spinner', spin: appBusy }), appBusy ? t('正在准备…', 'Preparing…') : t('一键准备好', 'Set it up for me')),
                              h('button', {
                                type: 'button', className: 'wxdl-btn wxdl-btn-sm',
                                disabled: appBusy,
                                onClick: () => { setPickingPath(true); setPathDraft(state?.settings?.appPath || ''); },
                              }, t('手动指定位置', 'Pick a file'))))
                        : null))
                  : null,

                stage === 'done' && result
                  ? h('div', { className: 'wxdl-state', 'data-tone': 'ok' },
                    h(Glyph, { name: 'check' }),
                    h('div', { className: 'wxdl-state-body' },
                      h('span', null, t('下载完成，已保存到：', 'Downloaded:') + ' ' + (result.path || result.name || '')),
                      h('div', { className: 'wxdl-state-actions' },
                        result.path || result.name
                          ? h('button', {
                            type: 'button', className: 'wxdl-btn wxdl-btn-sm',
                            onClick: async () => {
                              try {
                                const data = await rpc('open', { path: result.path || result.name });
                                if (data?.missing) setHint({ tone: 'warn', text: t('文件不在了（可能被移动或删除），已打开所在文件夹', 'The file is gone — opened its folder instead') });
                              } catch (error) {
                                setHint({ tone: 'bad', text: error.message });
                              }
                            },
                          }, h(Glyph, { name: 'folder' }), t('打开文件夹', 'Open folder'))
                          : null,
                        h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: () => { setStage('idle'); setResult(null); setPreview(null); setLink(''); setHint(null); } },
                          t('再下一个', 'Download another')))))
                  : null,

                preview && stage !== 'done'
                  ? h('div', { className: 'wxdl-preview' },
                    preview.cover
                      ? h('img', { className: 'wxdl-cover', src: preview.cover, alt: '', loading: 'lazy' })
                      : h('div', { className: 'wxdl-cover wxdl-cover-empty' }, h(Glyph, { name: 'download', size: 20 })),
                    h('div', { className: 'wxdl-preview-body' },
                      h('div', { className: 'wxdl-preview-title' }, preview.title || t('已解析到视频', 'Video resolved')),
                      h('div', { className: 'wxdl-preview-meta' }, [preview.author, preview.duration ? Math.round(preview.duration) + 's' : null].filter(Boolean).join(' · ') || '')))
                  : null,

                hint
                  ? h('div', { className: 'wxdl-state', 'data-tone': hint.tone, role: hint.tone === 'bad' ? 'alert' : 'status' },
                    h(Glyph, { name: hint.tone === 'bad' ? 'warning' : hint.tone === 'ok' ? 'check' : 'warning' }),
                    h('div', { className: 'wxdl-state-body' },
                      h('span', null, hint.text)))
                  : null,

                unguarded
                  ? h('div', { className: 'wxdl-state', 'data-tone': 'warn' },
                    h(Glyph, { name: 'warning' }),
                    h('div', { className: 'wxdl-state-body' },
                      h('span', null, t('下载期间系统代理被别的软件改过，所以我没覆盖它。现在用到的就是你当前那份设置。', 'Another program changed the proxy during the session, so it was left untouched.'))))
                  : null),

              h('details', { className: 'wxdl-advanced' },
                h('summary', null, t('代理与高级设置', 'Proxy and advanced')),
                h('div', { className: 'wxdl-advanced-body' },
                  h('dl', null,
                    h('div', { className: 'wxdl-row' },
                      h('dt', null, t('当前系统代理', 'Current proxy')),
                      h('dd', null, state?.system?.supported === false
                        ? t('非 Windows，不接管', 'not Windows')
                        : proxyActive
                          ? t('已被下载器临时接管', 'temporarily taken over')
                          : (state?.system?.enabled ? (state.system.server || t('已开启', 'enabled')) : t('未开启', 'off')))),
                    h('div', { className: 'wxdl-row' },
                      h('dt', null, t('本次还原点', 'Restore point')),
                      h('dd', null, proxyActive
                        ? (state?.session?.previousEnabled ? (state.session.previousServer || t('原来的代理', 'previous proxy')) : t('原来的状态：未开启', 'was: off'))
                        : t('无', 'none'))),
                    h('div', { className: 'wxdl-row' },
                      h('dt', null, t('视频号页面', 'Channels page')),
                      h('dd', null, channelsReady ? t('已连接', 'connected') : t('未连接', 'not connected'))),
                    h('div', { className: 'wxdl-row' },
                      h('dt', null, t('下载器', 'Downloader')),
                      h('dd', null, running ? (state?.tool?.version || t('运行中', 'running')) : t('未运行', 'offline')))),
                  state?.system?.autoConfigUrl
                    ? h('div', { className: 'wxdl-state', 'data-tone': 'warn', style: { marginTop: '10px' } },
                      h(Glyph, { name: 'warning' }),
                      h('div', { className: 'wxdl-state-body' }, h('span', null, t('你启用了 PAC 自动配置，它可能盖掉系统代理，导致抓不到微信流量。', 'A PAC script is configured and may override the system proxy.'))))
                    : null,
                  h('label', { className: 'wxdl-switch' },
                    h('input', {
                      type: 'checkbox', checked: autoRestore,
                      disabled: busy,
                      onChange: event => { setAutoRestore(event.target.checked); writeAutoRestore(event.target.checked); },
                    }),
                    h('i', { 'aria-hidden': 'true' }),
                    h('span', null, t('下载结束后自动还原代理', 'Restore the proxy when done'))),
                  h('label', { className: 'wxdl-switch' },
                    h('input', {
                      type: 'checkbox', checked: closeAfterDownload,
                      disabled: busy,
                      onChange: event => { setCloseAfterDownload(event.target.checked); writeCloseAfterDownload(event.target.checked); },
                    }),
                    h('i', { 'aria-hidden': 'true' }),
                    h('span', null, t('下载完成后空闲 5 分钟自动关闭', 'Stop the downloader after 5 idle minutes'))),
                  h('div', { className: 'wxdl-advanced-actions' },
                    h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', disabled: busy || !proxyActive, onClick: manualRestore },
                      h(Glyph, { name: 'shield' }), t('立即还原代理', 'Restore now')),
                    running
                      ? h('button', {
                        type: 'button', className: 'wxdl-btn wxdl-btn-sm', disabled: busy || appBusy,
                        onClick: async () => {
                          const data = await closeTool();
                          await refreshState();
                          setHint(data?.needsElevation
                            ? { tone: 'warn', text: t('下载器是管理员权限启动的，我关不掉它，请手动关闭那个窗口', 'It runs as administrator — close its window manually') }
                            : { tone: 'ok', text: t('下载器已关闭', 'Downloader stopped') });
                        },
                      }, t('关闭下载器', 'Stop downloader'))
                      : null,
                    h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', disabled: busy || appBusy, onClick: checkUpdate },
                      h(Glyph, { name: 'refresh', spin: appBusy }), t('检查更新', 'Check for updates'))),
                  editingApi
                    ? h('div', { className: 'wxdl-settings' },
                      h('span', null, t('服务地址', 'Service address')),
                      h('input', { className: 'wxdl-input', value: apiDraft, spellCheck: false, onChange: event => setApiDraft(event.target.value) }),
                      h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: saveApi }, t('保存', 'Save')),
                      h('button', { type: 'button', className: 'wxdl-btn wxdl-btn-sm', onClick: () => setEditingApi(false) }, t('取消', 'Cancel')))
                    : null)),

              h('footer', { className: 'wxdl-foot' },
                h('div', null,
                  h('a', {
                    href: '#',
                    onClick: event => { event.preventDefault(); setApiDraft(state?.settings?.apiBase || 'http://127.0.0.1:2022'); setEditingApi(true); },
                  }, state?.settings?.apiBase || 'http://127.0.0.1:2022'),
                  ' · ',
                  h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer noopener' }, 'wx_channels_download')),
                h('span', null, t('仅供学习研究，请遵守法律法规', 'For study and research only')))));
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ workbench: true }),
        }, Panel));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 28,
          label: () => (String(ctx.locale?.getSnapshot?.().active || '').startsWith('zh') ? '视频号下载器' : 'Channels downloader'),
        }, SidebarIcon));
      },
    };
  },
});