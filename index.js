/**
 * Host half of the WeChat Channels downloader workbench.
 *
 * Two jobs:
 *  1. A same-origin JSON gateway to the local wx_channels_download API
 *     (default http://127.0.0.1:2022), so the panel never depends on that
 *     process's CORS or on the page's connect-src policy.
 *  2. A proxy guard: snapshot the Windows system proxy before the downloader
 *     takes it over, then restore the exact previous settings afterwards.
 *     The downloader itself only flips ProxyEnable back to 0, which is why the
 *     user had to re-enter their own proxy every time.
 *
 * Nothing here is Windows-only except the proxy guard; the gateway works
 * wherever the downloader runs.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RPC_ROUTE = '/api/wx-channels-downloader/rpc';

// The override exists so the proxy guard can be exercised against a throwaway
// key in tests instead of the user's real Internet Settings.
const REG_KEY = process.env.WXDL_PROXY_REG_KEY
  || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PLUGIN_DIR = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'plugin-data',
  'wx-channels-downloader',
);
const SETTINGS_FILE = path.join(PLUGIN_DIR, 'settings.json');
const SNAPSHOT_FILE = path.join(PLUGIN_DIR, 'proxy-snapshot.json');

const PROXY_VALUE_NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'];
const PROXY_TIMEOUT_MS = 8000;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ store */

const store = {
  settings: null,
  snapshot: null,
};

async function loadSettings() {
  if (store.settings) return store.settings;
  let loaded = {};
  try {
    loaded = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    loaded = {};
  }
  store.settings = {
    apiBase: typeof loaded.apiBase === 'string' && loaded.apiBase.trim()
      ? loaded.apiBase.trim().replace(/\/+$/, '')
      : 'http://127.0.0.1:2022',
    downloadDir: typeof loaded.downloadDir === 'string' ? loaded.downloadDir.trim() : '',
    appPath: typeof loaded.appPath === 'string' ? loaded.appPath.trim() : '',
    appVersion: typeof loaded.appVersion === 'string' ? loaded.appVersion.trim() : '',
    lastGoodProxy: loaded.lastGoodProxy && loaded.lastGoodProxy.values ? loaded.lastGoodProxy : null,
  };
  return store.settings;
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  store.settings = next;
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const PREFERRED_DOWNLOAD_DIR = 'D:\\';

/** Videos are big; the D: drive root is the requested default, profile as fallback. */
async function resolveDownloadDir(settings) {
  const configured = String(settings.downloadDir || '').trim();
  if (configured) return configured;
  if (isWindows()) {
    const drive = path.parse(PREFERRED_DOWNLOAD_DIR).root;
    const exists = await fs.stat(drive).then(stat => stat.isDirectory()).catch(() => false);
    if (exists) return PREFERRED_DOWNLOAD_DIR;
  }
  return path.join(os.homedir(), 'Downloads');
}

/** A drive root already exists and cannot be created; only make missing folders. */
async function ensureDirectory(dir) {
  const existing = await fs.stat(dir).catch(() => null);
  if (existing && existing.isDirectory()) return dir;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureDownloadDir(settings) {
  return ensureDirectory(await resolveDownloadDir(settings));
}

async function loadSnapshot() {
  if (store.snapshot) return store.snapshot;
  try {
    const parsed = JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8'));
    store.snapshot = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    store.snapshot = null;
  }
  return store.snapshot;
}

async function saveSnapshot(snapshot) {
  store.snapshot = snapshot;
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  if (!snapshot) {
    await fs.rm(SNAPSHOT_FILE, { force: true });
    return;
  }
  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
}

/* ------------------------------------------------------- downloader API */

function normalizeBase(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function toolRequest(settings, route, options = {}) {
  const base = normalizeBase(settings.apiBase);
  if (!base) throw new RpcError('bad-api-base', '服务地址无效');
  const url = base + route;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new RpcError('tool-bad-response', '下载器返回了无法解析的内容');
    }
    if (!response.ok) {
      const message = payload && typeof payload.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
      throw new RpcError('tool-http', message);
    }
    if (payload && typeof payload.code === 'number' && payload.code !== 0) {
      throw new RpcError('tool-code', typeof payload.msg === 'string' ? payload.msg : '下载器返回错误');
    }
    return payload ? payload.data : null;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error && error.name === 'AbortError') throw new RpcError('tool-timeout', '下载器响应超时');
    throw new RpcError('tool-offline', '连接不到下载器服务，请先启动 wx_channels_download');
  } finally {
    clearTimeout(timer);
  }
}

async function readToolStatus(settings) {
  const data = await toolRequest(settings, '/api/status', { timeoutMs: 4000 });
  const proxyAddr = typeof data?.proxy?.addr === 'string' ? data.proxy.addr : '';
  return {
    running: true,
    version: typeof data?.version === 'string' ? data.version : null,
    proxy: {
      addr: proxyAddr,
      listening: Boolean(data?.proxy?.listening),
      status: data?.proxy?.status ?? null,
    },
    api: {
      addr: typeof data?.api?.addr === 'string' ? data.api.addr : null,
      listening: Boolean(data?.api?.listening),
    },
  };
}

async function readChannelsStatus(settings) {
  try {
    const data = await toolRequest(settings, '/api/channels/status', { timeoutMs: 4000 });
    return { available: Boolean(data?.available) };
  } catch {
    return { available: false };
  }
}

/* ---------------------------------------------------------- proxy guard */

function isWindows() {
  return process.platform === 'win32';
}


/**
 * Every console program (reg, tasklist, powershell) makes Windows Terminal pop a
 * window on this machine, so the plugin uses wscript instead: it is a GUI host,
 * spawns no console, and can still reach the registry and WMI.
 */
/**
 * hidden defaults to true: wscript is a GUI host, so hiding it only suppresses
 * the windows it creates. A script that must show a dialog passes hidden:false.
 */
async function runWscript(body, args = [], timeoutMs = 15000, options = {}) {
  const file = path.join(os.tmpdir(), `wxdl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.vbs`);
  await fs.writeFile(file, body, 'utf8');
  try {
    await execFileAsync('wscript.exe', ['//nologo', '//B', file, ...args], {
      windowsHide: options.hidden !== false,
      timeout: timeoutMs,
      encoding: 'latin1',
    });
    return true;
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * Native "browse for folder" dialog, shown by the shell through wscript so no
 * console window appears. Blocks until the user picks or cancels.
 */
const VBS_PICK_FOLDER = String.raw`Option Explicit
Dim shell, folder, outPath, fso, f, out
outPath = WScript.Arguments(0)
Set shell = CreateObject("Shell.Application")
Set folder = shell.BrowseForFolder(0, "选择视频保存位置", 0)
out = ""
If Not folder Is Nothing Then out = folder.Self.Path
Set fso = CreateObject("Scripting.FileSystemObject")
Set f = fso.CreateTextFile(outPath, True)
f.Write out
f.Close
`;

async function actionDirPick() {
  if (!isWindows()) throw new RpcError('unsupported-platform', '目录选择只支持 Windows');
  const out = path.join(os.tmpdir(), `wxdl-dir-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  try {
    await runWscript(VBS_PICK_FOLDER, [out], 180000, { hidden: false });
    const picked = String(await fs.readFile(out, 'latin1') || '').trim();
    return { path: picked, cancelled: !picked };
  } catch (error) {
    throw new RpcError('dir-pick-failed', `打不开目录选择框：${error?.message || '未知错误'}`);
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}

const VBS_READ_PROXY = String.raw`Option Explicit
Dim sh, key, outPath, names, i, n, v, ok, out
Set sh = CreateObject("WScript.Shell")
key = WScript.Arguments(0)
outPath = WScript.Arguments(1)
names = Array("ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL")
out = ""
For i = 0 To UBound(names)
  n = names(i)
  ok = "0"
  v = ""
  On Error Resume Next
  v = sh.RegRead(key & "\" & n)
  If Err.Number = 0 Then ok = "1" Else Err.Clear
  On Error GoTo 0
  out = out & n & vbTab & ok & vbTab & v & vbCrLf
Next
Dim fso, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set f = fso.CreateTextFile(outPath, True)
f.Write out
f.Close
`;

const VBS_WRITE_PROXY = String.raw`Option Explicit
Dim sh, key, act, name, kind, value
Set sh = CreateObject("WScript.Shell")
key = WScript.Arguments(0)
act = WScript.Arguments(1)
name = WScript.Arguments(2)
kind = WScript.Arguments(3)
value = WScript.Arguments(4)
On Error Resume Next
If act = "del" Then
  sh.RegDelete key & "\" & name
ElseIf kind = "REG_DWORD" Then
  If LCase(Left(value, 2)) = "0x" Then value = "&H" & Mid(value, 3)
  sh.RegWrite key & "\" & name, CLng(value), "REG_DWORD"
Else
  sh.RegWrite key & "\" & name, value, "REG_SZ"
End If
WScript.Quit 0
`;

const VBS_PROCESS = String.raw`Option Explicit
Dim svc, col, p, image, mode, outPath, out, fso, f
image = WScript.Arguments(0)
mode = WScript.Arguments(1)
outPath = WScript.Arguments(2)
out = ""
Set svc = GetObject("winmgmts:\\.\root\cimv2")
Set col = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & image & "'")
For Each p In col
  If mode = "kill" Then Call p.Terminate()
  out = out & p.ProcessId & vbCrLf
Next
Set fso = CreateObject("Scripting.FileSystemObject")
Set f = fso.CreateTextFile(outPath, True)
f.Write out
f.Close
`;

async function readProxyValues() {
  const out = path.join(os.tmpdir(), `wxdl-proxy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  try {
    await runWscript(VBS_READ_PROXY, [REG_KEY, out]);
    const text = await fs.readFile(out, 'latin1');
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const [name, exists, ...rest] = line.split('\t');
      if (!name) continue;
      values[name] = exists === '1' ? rest.join('\t') : null;
    }
    return values;
  } catch (error) {
    throw new RpcError('proxy-read-failed', `读取系统代理设置失败${error?.message ? ': ' + error.message : ''}`);
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}

async function readProxyState() {
  if (!isWindows()) {
    return { supported: false, enabled: false, server: null, values: null };
  }
  const values = await readProxyValues();
  const enableRaw = values.ProxyEnable;
  const enabled = enableRaw !== null && enableRaw !== undefined && enableRaw !== ''
    && Number.parseInt(String(enableRaw), 16) === 1;
  return { supported: true, enabled, server: values.ProxyServer, values };
}

async function writeRegValue(name, value) {
  const absent = value === null || value === undefined;
  const type = name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ';
  await runWscript(VBS_WRITE_PROXY, [
    REG_KEY,
    absent ? 'del' : 'set',
    name,
    type,
    absent ? '0' : String(value),
  ]);
}

async function queryProcessIds(image) {
  const out = path.join(os.tmpdir(), `wxdl-proc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  try {
    await runWscript(VBS_PROCESS, [image, 'count', out]);
    const text = await fs.readFile(out, 'latin1');
    // Number('') is 0, so blank lines must not count as a running process.
    return text
      .split(/\r?\n/)
      .map(item => Number(String(item).trim()))
      .filter(id => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}

async function killProcessImage(image) {
  const out = path.join(os.tmpdir(), `wxdl-kill-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  try {
    await runWscript(VBS_PROCESS, [image, 'kill', out]);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}
async function notifyProxyChanged() {
  try {
    await execFileAsync('rundll32.exe', ['user32.dll,UpdatePerUserSystemParameters', ',', '1'], {
      windowsHide: true,
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function proxyHostPort(addr) {
  const match = /^([^:]+):(\d+)$/.exec(String(addr || '').trim());
  return match ? { host: match[1], port: match[2] } : null;
}

async function currentPointsToOurProxy(ourAddr) {
  const state = await readProxyState();
  return { state, ours: isOurProxyServer(state.server, ourAddr) };
}

function isOurProxyServer(server, ourAddr) {
  const target = proxyHostPort(ourAddr);
  if (!target || !server) return false;
  const normalized = String(server).replace(/^(https?=)/i, '').trim();
  return normalized === `${target.host}:${target.port}`;
}

function snapshotFrom(state) {
  return {
    values: state.values,
    capturedAt: Date.now(),
    enabledBefore: state.enabled,
    serverBefore: state.server,
  };
}

async function restoreSnapshot() {
  const snapshot = await loadSnapshot();
  if (!snapshot || !snapshot.values) return { restored: false, reason: 'no-snapshot' };

  for (const name of PROXY_VALUE_NAMES) {
    await writeRegValue(name, snapshot.values[name] ?? null);
  }
  const notified = await notifyProxyChanged();
  await saveSnapshot(null);
  return { restored: true, notified };
}

/* ------------------------------------------------------------- actions */

async function buildState(ctx) {
  const settings = await loadSettings();
  let tool = { running: false, version: null, proxy: { addr: null, listening: false }, api: { addr: null } };
  try {
    tool = await readToolStatus(settings);
  } catch {
    tool = { ...tool, running: false };
  }
  const channels = tool.running ? await readChannelsStatus(settings) : { available: false };
  // Learn which build is actually running so update checks can compare it.
  if (tool.running && tool.version) {
    const runningVersion = normalizeVersion(tool.version);
    if (runningVersion && normalizeVersion(settings.appVersion) !== runningVersion) {
      await saveSettings({ appVersion: runningVersion }).catch(() => undefined);
      settings.appVersion = runningVersion;
    }
  }
  const system = await readProxyState();
  let snapshot = await loadSnapshot();
  // A session exists only while the registry actually points at the downloader;
  // otherwise it was already restored and a stale record would block the next run.
  if (snapshot && system.supported && !isOurProxyServer(system.server, snapshot.ourAddr || '127.0.0.1:2023')) {
    await saveSnapshot(null).catch(() => undefined);
    snapshot = null;
  }
  // While the downloader is stopped the registry holds the user's own proxy.
  // Remember it, so a takeover that happens before we snapshot can still be undone.
  if (!snapshot && !tool.running && system.supported && system.server && !isOurProxyServer(system.server, '127.0.0.1:2023')) {
    const good = snapshotFrom(system);
    if (JSON.stringify(good.values) !== JSON.stringify(settings.lastGoodProxy?.values ?? null)) {
      await saveSettings({ lastGoodProxy: good }).catch(() => undefined);
      settings.lastGoodProxy = good;
    }
  }
  // Resolve and remember where files go, so the panel can show it right away.
  const downloadDir = await resolveDownloadDir(settings);
  if (downloadDir !== settings.downloadDir) {
    await saveSettings({ downloadDir }).catch(() => undefined);
    settings.downloadDir = downloadDir;
  }
  return {
    platform: process.platform,
    settings: { apiBase: settings.apiBase, downloadDir, appPath: settings.appPath, appVersion: settings.appVersion },
    tool: { ...tool, channels },
    system: {
      supported: system.supported,
      enabled: system.enabled,
      server: system.server,
      autoConfigUrl: system.values ? system.values.AutoConfigURL : null,
    },
    session: snapshot
      ? { active: true, startedAt: snapshot.capturedAt, previousEnabled: snapshot.enabledBefore, previousServer: snapshot.serverBefore }
      : { active: false },
  };
}

async function actionProxyStart() {
  if (!isWindows()) throw new RpcError('unsupported-platform', '自动还原系统代理目前只支持 Windows');
  const settings = await loadSettings();
  const tool = await readToolStatus(settings);
  if (!tool.proxy.listening) {
    throw new RpcError('proxy-offline', '下载器的代理服务没有在监听，请先启动 wx_channels_download 并等待它启动完成');
  }

  // wx_channels_download points the system proxy at itself as soon as it starts,
  // so by the time this runs the registry may already be ours. Snapshot first
  // (falling back to the last known good proxy) before asking it to apply again.
  await ensureSnapshot(tool.proxy.addr);
  const current = await currentPointsToOurProxy(tool.proxy.addr);
  if (current.ours) return { started: true, already: true };

  // Take the proxy over from the plugin, never through the downloader: its
  // implementation shells out to reg.exe, which pops a terminal window here.
  const target = proxyHostPort(tool.proxy.addr);
  if (!target) throw new RpcError('proxy-offline', '下载器的代理地址无效');
  await writeRegValue('ProxyEnable', '1');
  await writeRegValue('ProxyServer', `${target.host}:${target.port}`);
  await notifyProxyChanged();

  const after = await currentPointsToOurProxy(tool.proxy.addr);
  if (!after.ours) throw new RpcError('proxy-not-applied', '代理已开启，但系统设置里没有指向下载器，可能被 PAC 或安全软件接管了');
  return { started: true };
}

/**
 * Capture the pre-session proxy, tolerating a downloader that already hijacked it:
 * in that case the last good value recorded while it was stopped is used instead.
 */
async function ensureSnapshot(ourAddr) {
  const existing = await loadSnapshot();
  if (existing) return existing;

  const state = await readProxyState();
  if (!state.supported) return null;

  if (isOurProxyServer(state.server, ourAddr)) {
    const settings = await loadSettings();
    if (settings.lastGoodProxy?.values) {
      const snapshot = { ...settings.lastGoodProxy, ourAddr, capturedAt: Date.now() };
      await saveSnapshot(snapshot);
      return snapshot;
    }
  }

  const snapshot = { ...snapshotFrom(state), ourAddr };
  await saveSnapshot(snapshot);
  return snapshot;
}

async function actionProxyStop() {
  if (!isWindows()) throw new RpcError('unsupported-platform', '自动还原系统代理目前只支持 Windows');
  const settings = await loadSettings();

  // Nothing was recorded, so there is nothing to undo.
  const recorded = await loadSnapshot();
  if (!recorded) return { restored: false, reason: 'no-snapshot' };

  let ourAddr = recorded.ourAddr || '127.0.0.1:2023';
  try {
    const tool = await readToolStatus(settings);
    if (tool.proxy.addr) ourAddr = tool.proxy.addr;
  } catch {
    /* the downloader may already be gone; the recorded address still applies */
  }

  // Decide before touching anything: the downloader's own "disable" only flips
  // ProxyEnable to 0, so afterwards we could no longer tell who owns ProxyServer.
  const before = await readProxyState();
  if (before.supported && before.server && !isOurProxyServer(before.server, ourAddr)) {
    await saveSnapshot(null);
    return { restored: false, reason: 'changed-by-other' };
  }

  // Skip the downloader's own disable: it also shells out to reg.exe, and the
  // snapshot restore below writes the registry anyway.
  return restoreSnapshot();
}

async function actionResolve(payload) {
  const url = String(payload?.url ?? '').trim();
  if (!url) throw new RpcError('bad-request', '请先粘贴视频号链接');
  if (!/^https?:\/\//i.test(url)) throw new RpcError('bad-link', '链接需要以 http(s):// 开头');
  const settings = await loadSettings();
  await readToolStatus(settings);
  const channels = await readChannelsStatus(settings);
  if (!channels.available) {
    throw new RpcError('channels-offline', '还没有连上视频号页面。请在微信里打开一次「视频号」，等它加载出来后再试。');
  }
  const response = await toolRequest(
    settings,
    `/api/channels/feed/profile?url=${encodeURIComponent(url)}`,
    { timeoutMs: 20000 },
  );
  // The injected page answers with { errCode, errMsg, data: { object } }.
  if (response && typeof response === 'object' && typeof response.errCode === 'number' && response.errCode !== 0) {
    throw new RpcError('profile-error', response.errMsg || '视频号页面返回了错误，请重新打开一次视频号再试');
  }
  const inner = response && typeof response === 'object' ? (response.data ?? response) : null;
  const object = inner && typeof inner === 'object' ? (inner.object ?? null) : null;
  if (!object) throw new RpcError('empty-profile', '这个链接没有解析出视频信息，可能是图文或已删除的内容');
  return {
    object,
    title: pickString(object, [['objectDesc', 'description'], ['desc'], ['title']]),
    cover: pickString(object, [
      ['objectDesc', 'media', 0, 'coverUrl'],
      ['objectDesc', 'media', 0, 'thumbUrl'],
      ['coverUrl'],
    ]),
    author: pickString(object, [['contact', 'nickname'], ['nickname']]),
    duration: pickNumber(object, [['objectDesc', 'media', 0, 'duration'], ['duration']]),
  };
}

function pickString(source, candidates) {
  for (const keys of candidates) {
    let node = source;
    for (const key of keys) {
      if (node === null || node === undefined) { node = undefined; break; }
      node = node[key];
    }
    if (typeof node === 'string' && node.trim()) return node.trim();
  }
  return null;
}

function pickNumber(source, candidates) {
  for (const keys of candidates) {
    let node = source;
    for (const key of keys) {
      if (node === null || node === undefined) { node = undefined; break; }
      node = node[key];
    }
    if (typeof node === 'number' && Number.isFinite(node)) return node;
  }
  return null;
}

/** Channels descriptions can be a whole paragraph; keep names usable on Windows. */
function cleanFilename(raw) {
  const text = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return '';
  const safe = text
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!safe) return '';
  return safe.length > 60 ? safe.slice(0, 60).trim() : safe;
}

async function actionDownload(payload) {
  const object = payload?.object;
  if (!object || typeof object !== 'object') throw new RpcError('bad-request', '缺少解析结果，请先解析链接');
  const settings = await loadSettings();
  const requestedDir = String(payload?.downloadDir ?? settings.downloadDir ?? '').trim();
  let downloadDir = '';
  try {
    if (requestedDir) {
      await ensureDirectory(requestedDir);
      downloadDir = requestedDir;
    } else {
      downloadDir = await ensureDownloadDir(settings);
    }
  } catch {
    throw new RpcError('bad-download-dir', `下载目录不可用：${requestedDir || await resolveDownloadDir(settings)}`);
  }
  const config = { platform: 'wxchannels', existing_action: 'skip' };
  // The endpoint takes a batch: {"objects":[ ... ]}, and answers with one
  // { code, msg, data } item per object.
  const task = {
    platform: 'wxchannels',
    content: object,
    config,
    auto_start: true,
  };
  if (downloadDir) task.download_dir = downloadDir;
  const filename = cleanFilename(payload?.title || object?.objectDesc?.description);
  if (filename) task.filename = filename;

  const created = await createTasks(settings, task);
  if (!created.length) throw new RpcError('create-failed', '下载器没有返回任务信息');

  // "Skipped" means the downloader kept an older task for this video. If that
  // file is gone, that older task is useless — download it again.
  const reused = created.find(item => item.skipped);
  if (reused && !(await taskFileExists(settings, reused.id))) {
    const retry = { ...task, config: { ...config, existing_action: 'overwrite', overwrite: true } };
    const again = await createTasks(settings, retry);
    if (again.length) return { tasks: again, redownloaded: true };
  }
  return { tasks: created };
}

async function createTasks(settings, task) {
  const data = await toolRequest(settings, '/api/v1/download_task/create', {
    method: 'POST',
    body: { objects: [task] },
    timeoutMs: 30000,
  });
  // Answer shape: { ids, tasks: [{ code, msg, data: { id, name, skipped } }] }
  const items = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [data];
  const created = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item.data ?? item;
    if (record && typeof record === 'object' && Number.isFinite(record.id)) {
      created.push({ id: record.id, name: record.name ?? null, skipped: Boolean(item.skipped ?? record.skipped) });
    }
    if (item.code !== undefined && Number(item.code) !== 0) {
      throw new RpcError('create-failed', String(item.msg ?? '创建下载任务失败'));
    }
  }
  return created;
}

async function taskFileExists(settings, id) {
  try {
    const record = await toolRequest(settings, '/api/v1/download_task/list?task_id=' + id, { timeoutMs: 6000 });
    const file = Array.isArray(record?.files) ? record.files[0] : null;
    return await fileExists(file?.file_path);
  } catch {
    return false;
  }
}

const TASK_STATUS = {
  0: 'waiting',
  1: 'preparing',
  2: 'downloading',
  3: 'paused',
  4: 'merging',
  5: 'finished',
  6: 'failed',
  7: 'cancelled',
};

async function fileExists(candidate) {
  if (!candidate) return false;
  const stat = await fs.stat(candidate).catch(() => null);
  return Boolean(stat && stat.isFile());
}

async function actionTasks(payload) {
  const settings = await loadSettings();
  const wanted = Array.isArray(payload?.ids) ? payload.ids.map(Number).filter(Number.isFinite) : [];
  if (wanted.length) {
    const tasks = [];
    for (const id of wanted) {
      try {
        const record = await toolRequest(settings, `/api/v1/download_task/list?task_id=${id}`, { timeoutMs: 6000 });
        if (record) tasks.push(normalizeTask(record));
      } catch (error) {
        if (error instanceof RpcError && error.code === 'tool-code') continue;
        throw error;
      }
    }
    return { tasks: await withExistence(tasks) };
  }
  const data = await toolRequest(settings, '/api/v1/download_task/list?page=1&page_size=30', { timeoutMs: 8000 });
  const list = Array.isArray(data?.list) ? data.list : [];
  return { tasks: await withExistence(list.map(normalizeTask)) };
}

/** A task can claim "finished" long after its file was moved away: verify on disk. */
async function withExistence(tasks) {
  for (const task of tasks) {
    if (task.path && (task.status === 'finished' || task.status === 'downloading')) {
      task.exists = await fileExists(task.path);
    }
  }
  return tasks;
}

function normalizeTask(record) {
  const files = Array.isArray(record?.files) ? record.files : [];
  const primary = files[0] ?? null;
  return {
    id: Number(record?.id) || 0,
    name: record?.name ?? '',
    status: TASK_STATUS[Number(record?.status)] ?? 'unknown',
    statusCode: Number(record?.status) || 0,
    progress: typeof record?.progress === 'number' ? record.progress : null,
    size: Number(record?.size) || 0,
    downloaded: Number(record?.downloaded) || 0,
    speed: Number(record?.speed) || 0,
    error: record?.error ?? '',
    cover: record?.cover_url ?? null,
    dir: primary?.download_dir ?? null,
    path: primary?.file_path ?? null,
    files: files.map(file => ({ name: file?.name ?? '', path: file?.file_path ?? null })),
    updatedAt: Number(record?.updated_at) || 0,
  };
}

/** Open Explorer directly: the downloader is usually stopped by the time this runs. */
async function actionOpen(payload) {
  const raw = String(payload?.path ?? '').trim();
  if (!raw) throw new RpcError('bad-request', '没有可打开的文件');
  // Never touch UNC paths: stat-ing them would open an SMB session to a remote host.
  if (/^\\\\/.test(raw)) throw new RpcError('bad-path', '不支持网络路径');
  const settings = await loadSettings();

  // Absolute path only: a relative one would make Explorer open its own CWD.
  let target = path.resolve(raw);
  let stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    const configured = String(settings.downloadDir || '').trim();
    const guess = configured ? path.join(configured, path.basename(raw)) : raw;
    target = path.resolve(guess);
    stat = await fs.stat(target).catch(() => null);
  }

  if (stat?.isFile()) {
    const ok = revealInExplorer(path.dirname(target));
    if (!ok) throw new RpcError('open-failed', '无法打开资源管理器');
    return { opened: path.dirname(target), file: target, missing: false };
  }
  const dir = stat?.isDirectory() ? target : path.dirname(target);
  const dirStat = await fs.stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    const fallback = String(settings.downloadDir || '').trim();
    if (fallback && (await fs.stat(fallback).catch(() => null))?.isDirectory()) {
      revealInExplorer(fallback);
      return { opened: fallback, missing: true };
    }
    throw new RpcError('not-found', `找不到这个文件：${raw}`);
  }
  revealInExplorer(dir);
  return { opened: dir, missing: !stat };
}

/**
 * Explorer's "/select," does not survive paths with spaces, so open the folder
 * itself — that always works and never lands in the wrong place.
 */
function revealInExplorer(dir) {
  const target = path.resolve(dir);
  try {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function actionSettings(payload) {
  const patch = {};
  if (typeof payload?.apiBase === 'string') {
    const base = normalizeBase(payload.apiBase.trim());
    if (!base) throw new RpcError('bad-api-base', '服务地址需要是 http:// 开头的地址');
    patch.apiBase = base;
  }
  if (typeof payload?.downloadDir === 'string') {
    const requested = payload.downloadDir.trim();
    if (requested) {
      if (!path.isAbsolute(requested)) throw new RpcError('bad-download-dir', '下载位置需要是完整路径，例如 D:\\微信视频下载');
      try {
        await ensureDirectory(requested);
      } catch {
        throw new RpcError('bad-download-dir', `无法创建这个目录：${requested}`);
      }
      patch.downloadDir = requested;
    }
  }
  if (typeof payload?.appPath === 'string') patch.appPath = payload.appPath.trim();
  if (Object.keys(patch).length) await saveSettings(patch);
  const settings = await loadSettings();
  return { settings: { ...settings, downloadDir: await resolveDownloadDir(settings) } };
}

/* ---------------------------------------------------- downloader process */

const APP_PATTERN = /(wx[_-]?(video|channels)[^\\/]*\.exe|wx[_-]?channels[^\\/]*\.exe)$/i;
const SOFTWARE_DIRS = /^(software|soft|tools|tool|apps?|programs?|downloads?|scoop|portable)$/i;

/** Local tool folders on every fixed drive: people keep these outside C:\. */
async function candidateDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'AppData', 'Local', 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
  ];
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const drive = String.fromCharCode(code) + ':\\';
    let entries;
    try {
      entries = await fs.readdir(drive, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SOFTWARE_DIRS.test(entry.name)) dirs.push(path.join(drive, entry.name));
    }
  }
  return [...new Set(dirs)];
}

async function scanForDownloader() {
  const found = [];
  const seen = new Set();

  async function consider(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (APP_PATTERN.test(entry.name)) {
          if (!seen.has(full.toLowerCase())) { seen.add(full.toLowerCase()); found.push(full); }
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      let inner;
      try {
        inner = await fs.readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of inner) {
        if (!child.isFile()) continue;
        // One level down: wx_video_download/wx_video_download.exe
        if (APP_PATTERN.test(child.name)) {
          const candidate = path.join(full, child.name);
          if (!seen.has(candidate.toLowerCase())) { seen.add(candidate.toLowerCase()); found.push(candidate); }
        }
      }
    }
  }

  for (const dir of await candidateDirs()) await consider(dir);

  // Prefer the canonical build name, then the shallowest path.
  found.sort((a, b) => {
    const rank = value => (/wx_video_download.*\.exe$/i.test(value) ? 0 : APP_PATTERN.test(value) ? 1 : 2);
    const diff = rank(a) - rank(b);
    if (diff) return diff;
    return a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b);
  });
  return found.slice(0, 8);
}

async function actionAppDetect() {
  const found = await scanForDownloader();
  if (found.length) {
    const chosen = found.find(item => /wx_video_download/i.test(item)) || found[0];
    await saveSettings({ appPath: chosen });
    return { found, appPath: chosen, chosen };
  }
  return { found: [], appPath: (await loadSettings()).appPath };
}

/* -------------------------------------------------- install and update */

const RELEASES_API = 'https://api.github.com/repos/ltaoo/wx_channels_download/releases/latest';
const INSTALL_ROOT = path.join(PLUGIN_DIR, 'app');
const DOWNLOAD_TIMEOUT_MS = 180000;

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function windowsAssetName(arch) {
  return arch === 'arm64' ? /windows_arm64\.zip$/i : /windows_x86_64\.zip$/i;
}

async function fetchReleaseJson() {
  const endpoints = [RELEASES_API, ...DOWNLOAD_MIRRORS.map(base => base + RELEASES_API)];
  let lastError = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new RpcError('release-unavailable', `GitHub 返回 ${response.status}`);
      const json = await response.json();
      if (json && typeof json === 'object') return json;
      throw new RpcError('release-unavailable', '版本信息格式异常');
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new RpcError('release-timeout', '查询版本超时') : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof RpcError ? lastError : new RpcError('release-unavailable', '连不上 GitHub，无法自动检查更新');
}

async function fetchLatestRelease() {
  try {
    const release = await fetchReleaseJson();
    const tag = normalizeVersion(release?.tag_name);
    if (!tag) throw new RpcError('release-unavailable', '没有拿到版本号');
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const wanted = windowsAssetName(process.arch);
    const asset = assets.find(item => wanted.test(String(item?.name || '')))
      || assets.find(item => /windows[^/]*\.zip$/i.test(String(item?.name || '')));
    return {
      tag,
      publishedAt: release?.published_at ?? null,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError('release-unavailable', '连不上 GitHub，无法自动检查更新');
  }
}

/**
 * Windows ships bsdtar, which reads zip; PowerShell's Expand-Archive autoloads
 * a module that is missing on some installs, so it is only the fallback.
 */
async function extractZip(zipPath, targetDir) {
  try {
    await execFileAsync('tar.exe', ['-xf', zipPath, '-C', targetDir], { windowsHide: true, timeout: 120000 });
    return;
  } catch (tarError) {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(targetDir)}, $true)`,
    ].join('; ');
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
        windowsHide: true,
        timeout: 120000,
      });
    } catch (psError) {
      throw new Error(`${tarError?.message || 'tar 解压失败'} / ${psError?.message || 'PowerShell 解压失败'}`);
    }
  }
}

async function findExecutable(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && APP_PATTERN.test(entry.name)) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findExecutable(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return null;
}

/**
 * GitHub release downloads are unreliable from mainland China, so the asset is
 * fetched through mirror prefixes when they are faster. All candidates are
 * probed in parallel and the quickest one wins — mirrors get a small bonus so
 * they win ties without penalising a fast direct connection.
 */
const DOWNLOAD_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://github.moeyy.xyz/',
];
const MIRROR_BONUS_MS = 250;
const PROBE_TIMEOUT_MS = 6000;

function assetCandidates(url) {
  const list = DOWNLOAD_MIRRORS.map(base => ({ url: base + url, mirror: true }));
  list.push({ url, mirror: false });
  return list;
}

async function probeUrl(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(candidate.url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok && response.status !== 206) return null;
    await response.arrayBuffer();
    const latency = Date.now() - started - (candidate.mirror ? MIRROR_BONUS_MS : 0);
    return { ...candidate, latency };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** First candidate that answers wins, so a slow route never delays the others. */
async function pickFastest(candidates) {
  return new Promise(resolve => {
    let settled = false;
    let pending = candidates.length;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const deadline = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    for (const candidate of candidates) {
      probeUrl(candidate)
        .then(result => {
          if (result) {
            clearTimeout(deadline);
            finish(result);
          }
        })
        .finally(() => {
          pending -= 1;
          if (!pending) {
            clearTimeout(deadline);
            finish(null);
          }
        });
    }
  });
}

async function downloadAsset(url) {
  const candidates = assetCandidates(url);
  const fastest = await pickFastest(candidates);
  const attempts = [];
  if (fastest) attempts.push(fastest.url);
  for (const candidate of candidates) {
    if (!attempts.includes(candidate.url)) attempts.push(candidate.url);
  }

  let lastError = null;
  for (const candidate of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(candidate, { redirect: 'follow', signal: controller.signal });
      if (!response.ok) throw new RpcError('download-failed', `下载构建包失败（HTTP ${response.status}）`);
      const data = Buffer.from(await response.arrayBuffer());
      // A proxy error page is not a zip; check the magic bytes before trusting it.
      if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
        throw new RpcError('download-failed', '下载到的不是压缩包（可能被镜像拦截）');
      }
      return data;
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError') { lastError = new RpcError('download-timeout', '下载构建包超时'); continue; }
      if (error instanceof RpcError) continue;
      lastError = new RpcError('download-failed', '下载构建包失败（网络或者被墙）');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof RpcError ? lastError : new RpcError('download-failed', '下载构建包失败（所有地址都不可用）');
}

async function downloadAndInstall(release) {
  if (!release.asset?.url) throw new RpcError('no-asset', '这个版本没有 Windows 构建包');
  const arch = process.platform === 'win32' ? 'windows' : 'other';
  if (arch !== 'windows') throw new RpcError('unsupported-platform', '自动安装目前只支持 Windows');

  const zipPath = path.join(os.tmpdir(), `wxdl-${release.tag}-${Date.now()}.zip`);
  const buffer = await downloadAsset(release.asset.url);
  await fs.writeFile(zipPath, buffer);

  const targetDir = path.join(INSTALL_ROOT, release.tag);
  await fs.mkdir(targetDir, { recursive: true });
  try {
    await extractZip(zipPath, targetDir);
  } catch (error) {
    throw new RpcError('unzip-failed', `解压失败：${error?.message || '未知错误'}`);
  } finally {
    await fs.rm(zipPath, { force: true });
  }

  const executable = await findExecutable(targetDir);
  if (!executable) throw new RpcError('no-executable', '构建包里没有找到 exe');
  return { executable, tag: release.tag };
}

let ensureInFlight = null;
let updateInFlight = null;

function installedExecutable(settings) {
  return String(settings.appPath || '').trim();
}

async function isInstalled(settings) {
  const current = installedExecutable(settings);
  if (!current) return false;
  const stat = await fs.stat(current).catch(() => null);
  return Boolean(stat?.isFile());
}

/**
 * Local-only check used on the click path: never touches the network, because
 * the downloader owns the system proxy at that moment and an outbound request
 * to GitHub can sit there forever.
 */
async function actionAppEnsure() {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = (async () => {
    const settings = await loadSettings();
    const current = installedExecutable(settings);
    if (!(await isInstalled(settings))) {
      return { action: 'missing', appPath: '' };
    }
    const known = normalizeVersion(settings.appVersion);
    return {
      action: known ? 'up-to-date' : 'installed-unknown',
      appPath: current,
      version: known || null,
    };
  })();
  try {
    return await ensureInFlight;
  } finally {
    ensureInFlight = null;
  }
}

/** Explicit check-and-update; called from the button or after a download finished. */
async function actionAppUpdate(payload) {
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    const settings = await loadSettings();
    const current = installedExecutable(settings);
    const installed = await isInstalled(settings);

    let release = null;
    let checkError = null;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      checkError = error;
    }

    if (!release) {
      if (installed) return { action: 'offline-installed', appPath: current, error: checkError?.message ?? null };
      throw checkError ?? new RpcError('release-unavailable', '无法获取版本信息');
    }

    const known = normalizeVersion(settings.appVersion);
    const outdated = installed && known && known !== release.tag;
    const fresh = installed && known && known === release.tag;
    if (fresh && !payload?.force) {
      return { action: 'up-to-date', appPath: current, version: known, latest: release.tag };
    }
    // A build we did not install has no recorded version: start it first, record
    // what it reports, and let the next check decide whether it needs an update
    // instead of downloading a duplicate copy.
    if (installed && !known && !payload?.force) {
      return { action: 'installed-unknown', appPath: current, latest: release.tag };
    }

    try {
      const result = await downloadAndInstall(release);
      await saveSettings({ appPath: result.executable, appVersion: result.tag });
      return {
        action: installed ? (outdated ? 'updated' : 'reinstalled') : 'installed',
        appPath: result.executable,
        version: result.tag,
        latest: release.tag,
        previous: known || null,
      };
    } catch (error) {
      if (installed) {
        return {
          action: 'offline-installed',
          appPath: current,
          version: known || null,
          latest: release.tag,
          error: error instanceof Error ? error.message : '更新失败',
        };
      }
      throw error instanceof RpcError ? error : new RpcError('install-failed', '安装失败');
    }
  })();
  try {
    return await updateInFlight;
  } finally {
    updateInFlight = null;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toolImageName(appPath) {
  const base = path.basename(String(appPath || 'wx_video_download.exe')).replace(/\.exe$/i, '');
  return base || 'wx_video_download';
}

/** A live process that answers no API is wedged, not absent. */
async function isToolProcessRunning(appPath) {
  if (!isWindows()) return false;
  return isProcessImageRunning(`${toolImageName(appPath)}.exe`);
}

let appStartInFlight = null;

async function actionAppStart(payload) {
  if (appStartInFlight) return appStartInFlight;
  appStartInFlight = (async () => {
    const settings = await loadSettings();
    const candidate = String(payload?.path ?? settings.appPath ?? '').trim();
    if (!candidate) throw new RpcError('no-app-path', '还没找到下载器程序，请先在选择窗口里挑一下');
    let stat = null;
    try {
      stat = await fs.stat(candidate);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) throw new RpcError('bad-app-path', '这个路径下没有可执行文件');
    await saveSettings({ appPath: candidate });

    // Already up: never launch a second copy (it would fight over the ports and database).
    const apiAlive = await readToolStatus(settings).then(() => true).catch(() => false);
    if (apiAlive) return { started: false, alreadyRunning: true };

    if (await isToolProcessRunning(candidate)) {
      throw new RpcError(
        'tool-unresponsive',
        '下载器进程还在，但接口没有响应（它卡住了）。点「重启下载器」，我会关掉它再重新启动。',
      );
    }

    // The downloader sets the system proxy as part of its own startup, so the
    // restore point has to exist before that happens, not after.
    if (isWindows()) await ensureSnapshot('127.0.0.1:2023').catch(() => undefined);

    // Start without elevation first: such a process is ours to stop afterwards,
    // which is what makes "close it when the download finishes" possible.
    // One ordinary console window: it shows up immediately, stays put while the
    // download runs, and the plugin closes it afterwards. Console children of the
    // downloader (it runs reg.exe for the proxy) inherit it instead of flashing.
    try {
      // CREATE_NO_WINDOW: the downloader gets a console but no window, and its
      // own console children (reg.exe while it sets the proxy) inherit that
      // hidden console instead of opening their own.
      const child = spawn(candidate, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(candidate),
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
      if (await waitForToolApi(settings, 8000)) {
        return { started: true, elevated: false, stoppable: true };
      }
      if (await isProcessImageRunning(candidate)) {
        // Alive but slow to answer: never kill it and retry under UAC, that is
        // what made windows flash. Just report that it is still starting.
        if (await waitForToolApi(settings, 20000)) {
          return { started: true, elevated: false, stoppable: true };
        }
        return { started: true, elevated: false, stoppable: true, slow: true };
      }
      // Gone: either it still needs its root certificate once, or a previous
      // instance still holds the ports. Retry once without ever asking for
      // elevation — a UAC prompt is exactly the "flashing" this must avoid.
      await killToolImage(candidate);
      await sleepMs(1500);
      const retry = spawn(candidate, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(candidate),
        windowsHide: true,
      });
      retry.on('error', () => {});
      retry.unref();
      if (await waitForToolApi(settings, 12000)) {
        return { started: true, elevated: false, stoppable: true, retried: true };
      }
      throw new RpcError(
        'needs-admin',
        '下载器没能启动。如果这是第一次运行，请右键「以管理员身份运行」wx_channels_download 一次（安装根证书），之后就不需要管理员权限了。',
      );
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('app-start-failed', `启动失败：${error?.message || '未知错误'}`);
    }
  })();
  try {
    return await appStartInFlight;
  } finally {
    appStartInFlight = null;
  }
}

async function waitForToolApi(settings, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await readToolStatus(settings).then(() => true).catch(() => false);
    if (alive) return true;
    await sleepMs(1000);
  }
  return false;
}

async function killToolImage(candidate) {
  const image = `${toolImageName(candidate)}.exe`;
  if (!(await isProcessImageRunning(image))) return true;
  await killProcessImage(image);
  // WMI termination is asynchronous; give it a few seconds before failing.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleepMs(400);
    if (!(await isProcessImageRunning(image))) return true;
  }
  return false;
}

async function actionAppStop() {
  const settings = await loadSettings();
  const candidate = String(settings.appPath || '').trim();
  if (!candidate) return { stopped: true, wasRunning: false };
  const image = `${toolImageName(candidate)}.exe`;
  const wasRunning = await isProcessImageRunning(image);
  if (!wasRunning) return { stopped: true, wasRunning: false };
  const killed = await killToolImage(candidate);
  return killed
    ? { stopped: true, wasRunning: true }
    : { stopped: false, wasRunning: true, needsElevation: true };
}

async function actionAppRestart() {
  const settings = await loadSettings();
  const candidate = String(settings.appPath || '').trim();
  if (!candidate) throw new RpcError('no-app-path', '还没有下载器路径');
  const image = `${toolImageName(candidate)}.exe`;

  await killToolImage(candidate);
  await sleepMs(1200);
  if (!(await isProcessImageRunning(image))) {
    return { ...(await actionAppStart({ path: candidate })), restarted: true };
  }
  throw new RpcError('app-restart-failed', '下载器还在运行，无法重启（可能以管理员身份启动，请手动关闭它的窗口）。');
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------- wechat */

const WECHAT_IMAGES = ['Weixin.exe', 'WeChat.exe', 'WeChatAppEx.exe', 'WeChatPlayer.exe'];
const WECHAT_CANDIDATES = [
  'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
  'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
  'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
];

async function isProcessImageRunning(image) {
  const ids = await queryProcessIds(image);
  return ids.length > 0;
}

/**
 * stdout capture is unreliable in some hosts, so the path is written to a file
 * and read back; well-known install locations are the last resort.
 */
async function findWeChatExecutable() {
  const scratch = path.join(os.tmpdir(), `wxdl-wechat-${process.pid}.txt`);
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      `Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path | Set-Content -LiteralPath ${psQuote(scratch)} -Encoding UTF8`,
    ], { windowsHide: true, timeout: 20000 });
    const text = String(await fs.readFile(scratch, 'utf8')).trim();
    if (text) return text;
  } catch {
    /* fall through */
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => undefined);
  }
  for (const candidate of WECHAT_CANDIDATES) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return '';
}

/**
 * WeChat's webview processes pick their network path when they start, so a
 * window opened before the proxy was on never reaches the interceptor. Putting
 * WeChat back up is the only reliable way to reattach it.
 */
async function actionWechatRestart() {
  if (!isWindows()) throw new RpcError('unsupported-platform', '重启微信只支持 Windows');
  const settings = await loadSettings();

  const running = (await isProcessImageRunning('Weixin.exe')) || (await isProcessImageRunning('WeChat.exe'));
  const executable = await findWeChatExecutable();
  if (!running && !executable) {
    throw new RpcError('wechat-not-found', '没有检测到微信，请先打开微信再点这个按钮');
  }
  if (!executable) {
    throw new RpcError('wechat-path-unknown', '找不到微信的安装位置。可以手动退出微信再重新打开，效果一样。');
  }

  for (const image of WECHAT_IMAGES) await killProcessImage(image);
  await sleepMs(2500);

  // Keep the proxy on: the fresh webview must come up through the interceptor.
  try {
    const tool = await readToolStatus(settings);
    const ours = isOurProxyServer((await readProxyState()).server, tool.proxy.addr);
    if (!ours) {
      await ensureSnapshot(tool.proxy.addr);
      const target = proxyHostPort(tool.proxy.addr);
      if (target) {
        await writeRegValue('ProxyEnable', '1');
        await writeRegValue('ProxyServer', `${target.host}:${target.port}`);
        await notifyProxyChanged();
      }
    }
  } catch {
    /* proxy handling is best effort here */
  }

  try {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    throw new RpcError('wechat-start-failed', `微信重启失败：${error?.message || '未知错误'}`);
  }
  return { restarted: true, executable };
}

/* ------------------------------------------------------------ clipboard */

async function actionClipboardRead() {
  try {
    const electron = await import('electron');
    if (electron.clipboard && typeof electron.clipboard.readText === 'function') {
      // In-app clipboard needs no child process; never fall through to
      // PowerShell here, that would spawn a console on every window focus.
      return { text: String(electron.clipboard.readText() || '') };
    }
  } catch {
    /* not running inside Electron */
  }
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Get-Clipboard -Raw',
    ], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    return { text: String(stdout || '') };
  } catch {
    return { text: '' };
  }
}

/* ---------------------------------------------------------------- http */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new RpcError('body-too-large', '请求体过大');
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcError('bad-json', '请求体不是合法 JSON');
  }
}

const ACTIONS = {
  state: () => buildState(),
  'proxy.start': actionProxyStart,
  'proxy.stop': actionProxyStop,
  resolve: actionResolve,
  download: actionDownload,
  tasks: actionTasks,
  open: actionOpen,
  settings: actionSettings,
  'app.detect': actionAppDetect,
  'app.start': actionAppStart,
  'app.restart': actionAppRestart,
  'app.stop': actionAppStop,
  'wechat.restart': actionWechatRestart,
  'clipboard.read': actionClipboardRead,
  'dir.pick': actionDirPick,
  'app.ensure': actionAppEnsure,
  'app.update': actionAppUpdate,
};

async function handleRpc(req, res, connection) {
  try {
    const rejection = connection && typeof connection.requestRejection === 'function'
      ? connection.requestRejection(req)
      : undefined;
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: { code: 'forbidden', message: '请求被拒绝' } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '需要 POST' } });
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: { code: 'json-required', message: '需要 application/json' } });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body?.action ?? '');
    const handler = ACTIONS[action];
    if (!handler) {
      sendJson(res, 400, { ok: false, error: { code: 'unknown-action', message: `未知操作: ${action}` } });
      return;
    }
    const data = await handler(body?.payload ?? {});
    if (action === 'proxy.start') {
      sendJson(res, 200, { ok: true, data: { ...data, state: await buildState() } });
      return;
    }
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : 'internal';
    const message = error instanceof Error ? error.message : '未知错误';
    const status = error instanceof RpcError && error.code === 'bad-request' ? 400 : 200;
    sendJson(res, status, { ok: false, error: { code, message } });
  }
}

export function apply(ctx) {
  ctx.inject(['connection', 'webServer'], web => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: RPC_ROUTE,
      handler: (req, res) => handleRpc(req, res, web.connection),
    }), 'wx-channels-downloader: rpc gateway');
  });
}