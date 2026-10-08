#!/usr/bin/env node
/* =====================================================================
 * Xmind Local Patch — 零依赖自动化补丁
 * 适用:Xmind 26.05.x (Vana-Zen) Windows x64,便携版与安装版
 * 原理:asar 解包 → JS 层授权状态机修正 → 主进程运行时 hook 注入 → resources/app 部署
 * 用法:
 *   node patch.js [Xmind目录]            应用补丁(默认自动探测)
 *   node patch.js [Xmind目录] --restore  还原原版
 * 零第三方依赖;无 Node.js 时可用 Xmind 自带运行时(见 启动补丁.bat)
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const TAG = '[xmind-patch]';
const log = (m) => console.log(TAG, m);

/* ---------------- 定位 resources 目录 ---------------- */
function locateResources() {
  const arg = (process.argv[2] || '').replace(/^"+|"+$/g, '');
  const cands = [];
  if (arg) {
    cands.push(arg);
    cands.push(path.join(arg, 'resources'));
  }
  cands.push(path.join(process.cwd(), 'resources'));
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Xmind', 'resources'));
  cands.push('C:\\Program Files\\Xmind\\resources');
  cands.push('C:\\Program Files (x86)\\Xmind\\resources');
  for (const c of cands) {
    if (c && (fs.existsSync(path.join(c, 'app.asar')) || fs.existsSync(path.join(c, 'app.asar.orig')))) return c;
  }
  return null;
}

/* ---------------- asar 解包(零依赖) ---------------- */
function asarExtract(asarPath, unpackedPath, destRoot) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // asar 布局: [0..4)=4 [4..8)=headerSize [8..12)=payloadSize [12..16)=jsonLen [16..16+jsonLen)=JSON
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const base = 8 + headerSize;
  let files = 0, dirs = 0;

  const walk = (node, dir) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = path.join(dir, name);
      if (child.files) { dirs++; walk(child, p); continue; }
      if (child.unpacked) {
        const src = path.join(unpackedPath || '', path.relative(destRoot, p));
        if (fs.existsSync(src)) fs.copyFileSync(src, p);
        else if (child.size > 0) log(`WARN 未找到 unpacked 文件: ${path.relative(destRoot, p)}`);
        files++;
        continue;
      }
      const size = child.size || 0;
      const buf = Buffer.alloc(size);
      if (size) fs.readSync(fd, buf, 0, size, base + Number(child.offset));
      fs.writeFileSync(p, buf);
      files++;
    }
  };
  walk(header, destRoot);
  fs.closeSync(fd);
  return { files, dirs };
}

/* ---------------- 补丁定义(JS 层授权状态机 + 主进程 hook) ---------------- */
// renderer/common.js — 状态机根与验签(5 处 literal)
const COMMON_PATCHES = [
  // status 恒 VALID + isStatusValid 恒 true → 个人计划=Pro
  ['d=(0,r.computed)((()=>I.value===f.wi.VALID?f.wi.VALID:t.value===f.wi.EXPIRED||I.value===f.wi.EXPIRED||w.value===f.wi.EXPIRED?f.wi.EXPIRED:f.wi.TRIAL)),c=(0,r.computed)((()=>d.value===f.wi.VALID)),',
   'd=(0,r.computed)((()=>f.wi.VALID)),c=(0,r.computed)((()=>!0)),'],
  // perMachineLicenseStatus 恒 VALID → accountType=lic_zen(永久授权)
  ['w=(0,r.computed)((()=>{const e=k(y.value);return e===f.lX.E_OUTDATED?f.wi.EXPIRED:e===f.lX.VALID?f.wi.VALID:f.wi.TRIAL}))',
   'w=(0,r.computed)((()=>f.wi.VALID))'],
  // 渲染层 RSA 验签恒通过
  ['try{const e=i().createVerify("RSA-SHA256");e.update(p),e.end();const a=e.verify(l,g);return n.log("Verify License: ",a),a}',
   'try{const a=!0;return n.log("Verify License: ",a),a}'],
  // 功能门控总闸
  ['checkActivationValid:e=>{const{planType:a,teamId:t,feature:r}=e||{planType:V.PERSONAL},o=t&&t===(0,K.c)().user,i=h.value[V.PERSONAL]===W.PROPLUS,n=h.value[V.PERSONAL]===W.PREMIUM,l=h.value[V.PERSONAL]===W.DEPRECATED_TEAM,d=h.value[V.PERSONAL]===W.DEPRECATED_PERSONAL,c=r&&f.dZ.includes(r),u=r&&f.MM.includes(r);if(r&&f.zc.includes(r)&&!s.value)return!0;if(a===V.PERSONAL){const e=i||n||l||d;return!(o||!v.value)||(c||u?e:!(!h.value[V.PERSONAL]||h.value[V.PERSONAL]===W.FREE||h.value[V.PERSONAL]===W.UN_KNOWN||h.value[V.PERSONAL]===W.UN_SUPPORTED))}return!(!h.value[t]||h.value[t]===H.FREE||h.value[t]===H.UN_KNOWN||h.value[t]===H.UN_SUPPORTED)},',
   'checkActivationValid:()=>!0,'],
  // 序列号校验恒 VALID(激活对话框任意输入放行)
  ['k=e=>{if(!e||"object"!=typeof e)return f.lX.E_LICENSE_MISSING;if(!(0,z.q)().hardwareFingerprint)return f.lX.E_MACHINE_ID_UNMATCHED;const{key:a,email:t}=e,r=P(a,t);return r!==f.lX.VALID?r:f.lX.VALID}',
   'k=()=>f.lX.VALID'],
];
// 激活对话框 catch 强制走离线路径(任意 chunk)
const CATCH_REGEXES = [
  [/if\([A-Za-z_$][A-Za-z0-9_$]*\.includes\(([a-z])\.code\)\)return void\(([a-z])\.value=\1\.code\);/g, ''],
  [/if\(([a-z])\.J5\)return void\(([a-z])\.value=\1\.Zr\.E_SERVER_ERR\);/g, ''],
];

// main/main.js 前缀 hook(v6)
const MAIN_HOOK = `/* xm-neutralize v6: verify neutralizer + EPIPE immunity + auto-activation + event-driven dialog guard */
(function () {
  try {
    for (const s of [process.stdout, process.stderr]) {
      if (s && typeof s.on === 'function' && !s.__xmEPIPE) {
        s.on('error', (e) => { if (e && e.code === 'EPIPE') return; throw e; });
        s.__xmEPIPE = true;
      }
    }
    const xmc = require('crypto');
    if (xmc && typeof xmc.createVerify === 'function' && !xmc.__xmNZ) {
      const xmOrig = xmc.createVerify;
      const xmPatched = function () {
        const v = xmOrig.apply(this, arguments);
        if (v && typeof v.verify === 'function' && !v.__xmNZ) {
          v.verify = function () { return true; };
          v.__xmNZ = true;
        }
        return v;
      };
      Object.defineProperty(xmc, 'createVerify', { value: xmPatched, writable: true, configurable: true });
      xmc.__xmNZ = true;
    }
    const xmElectron = require('electron');
    if (!xmElectron || !xmElectron.app) return;
    try {
      const xmDlg = xmElectron.dialog;
      if (xmDlg && !xmDlg.__xmNZ) {
        for (const xmM of ['showMessageBox', 'showMessageBoxSync']) {
          const xmOrigM = xmDlg[xmM];
          if (typeof xmOrigM !== 'function') continue;
          const xmWrapped = function () {
            try {
              const o = arguments[0];
              const blob = JSON.stringify(o && (typeof o === 'object') ? { t: o.title, m: o.message, d: o.detail, c: o.checkboxLabel } : o || '');
              if (/licen[cs]e|serial|序列号|激活/i.test(blob)) {
                return xmM === 'showMessageBoxSync' ? 0 : Promise.resolve({ response: 0 });
              }
            } catch (e) {}
            return xmOrigM.apply(this, arguments);
          };
          Object.defineProperty(xmDlg, xmM, { value: xmWrapped, writable: true, configurable: true });
        }
        xmDlg.__xmNZ = true;
      }
    } catch (e) {}
    try {
      const xmBW = xmElectron.BrowserWindow;
      if (xmBW && xmBW.prototype && !xmBW.prototype.__xmNZ) {
        const xmOrigLoad = xmBW.prototype.loadURL;
        if (typeof xmOrigLoad === 'function') {
          xmBW.prototype.loadURL = function (url) {
            try {
              if (typeof url === 'string' && /dialog-(license|enterpassword)/.test(url)) {
                try { this.close(); } catch (e) {}
                return Promise.resolve();
              }
            } catch (e) {}
            return xmOrigLoad.apply(this, arguments);
          };
          xmBW.prototype.__xmNZ = true;
        }
      }
    } catch (e) {}
    const xmKEY = 'XAXMH0C990AAKITZCHIKYCGGHFXUTRCL7T5CGLTZSYYUNGAD2XPITZFCFRRXI2WW7F3ZXZ4YQM7BPMS5IUSGX7ZMHTSVWC24FNYZVIEEGBNHZHMRLJCC4VJT6DRMHYEO6WNJMVLDHUV23QMSZ2N5IHDHSD4ENOPETHOKULHSWZCCTDDX2WQ32WNXRWNSOYNHQPGY7LLTNLAQV37NWHHREQWIFWNBPBG6H';
    const xmEMAIL = 'local-license@xmind.local';
    const xmInject = (wc) => {
      try {
        if (!wc || wc.isDestroyed()) return;
        wc.executeJavaScript(
          '(async () => { try {' +
          '  const { ipcRenderer } = window.require("electron");' +
          '  if (!ipcRenderer) return;' +
          '  const call = (ch, payload) => new Promise((resolve) => {' +
          '    const seq = Math.floor(Math.random() * 1e9);' +
          '    ipcRenderer.once("ipc-api-reply:" + ch + ":" + seq, (ev, res) => resolve(res));' +
          '    ipcRenderer.send("ipc-api:" + ch, { payload, seq });' +
          '    setTimeout(() => resolve(null), 8000);' +
          '  });' +
          '  const st = await call("GET /pinia/store/state", {});' +
          '  const txt = typeof st === "string" ? st : JSON.stringify(st || {});' +
          '  if (txt.includes("' + xmKEY.slice(0, 12) + '")) return;' +
          '  await call("POST /pinia/store/mutations", { mutations: [{ id: "activation", type: "updateRawPerMachineLicenseData", payload: [{ rawData: { key: "' + xmKEY + '", email: "' + xmEMAIL + '", data: "Xmind Local License" } }] }] });' +
          '} catch (e) {} })()',
          true
        ).catch(() => {});
      } catch (e) { /* destroyed mid-call */ }
    };
    xmElectron.app.whenReady().then(() => {
      try {
        const ses = xmElectron.session.defaultSession;
        ses.protocol.handle('https', (req) => {
          try {
            const u = new URL(req.url);
            if (u.pathname === '/_res/verify-sme-license' || u.pathname === '/_api/license-activations') {
              return Promise.reject(new Error('xm-offline'));
            }
          } catch (e) {}
          return ses.fetch(req, { bypassCustomProtocolHandlers: true });
        });
      } catch (e) { /* silent */ }
      setTimeout(() => {
        let wins = [];
        try { wins = xmElectron.BrowserWindow.getAllWindows(); } catch (e) { return; }
        for (const w of wins) {
          try {
            const wc = w.webContents;
            if (wc && !wc.isDestroyed()) xmInject(wc);
          } catch (e) { /* window destroyed */ }
        }
      }, 8000);
      xmElectron.app.on('browser-window-created', (ev, w) => {
        try {
          const wc = w.webContents;
          if (!wc) return;
          wc.on('did-finish-load', () => {
            setTimeout(() => {
              try {
                if (!wc.isDestroyed()) xmInject(wc);
              } catch (e) { /* destroyed during delay */ }
            }, 4000);
          });
        } catch (e) { /* silent */ }
      });
    });
  } catch (e) { /* silent */ }
})();
`;

/* ---------------- 主流程 ---------------- */
const res = locateResources();
if (!res) {
  log('未找到 Xmind(需存在 resources/app.asar)。');
  log('用法: node patch.js [Xmind安装目录或resources目录] [--restore]');
  process.exit(1);
}
const asar = path.join(res, 'app.asar');
const orig = path.join(res, 'app.asar.orig');
const appDir = path.join(res, 'app');
const unpacked = path.join(res, 'app.asar.unpacked');

if (process.argv.includes('--restore') || process.argv.includes('-r')) {
  if (fs.existsSync(appDir)) { fs.rmSync(appDir, { recursive: true, force: true }); log('已移除补丁目录 resources/app'); }
  if (fs.existsSync(orig) && !fs.existsSync(asar)) { fs.renameSync(orig, asar); log('已还原 app.asar'); }
  else if (fs.existsSync(asar)) log('app.asar 已是原版');
  else { log('错误:找不到 app.asar 或备份!'); process.exit(1); }
  log('还原完成。');
  process.exit(0);
}

// 1) 备份
if (fs.existsSync(asar) && !fs.existsSync(orig)) {
  fs.renameSync(asar, orig);
  log('已备份 app.asar -> app.asar.orig');
}
if (!fs.existsSync(orig)) { log('错误:缺少原版 app.asar 备份。'); process.exit(1); }
if (fs.existsSync(asar)) fs.rmSync(asar);

// 2) 解包原版
log('解包 app.asar ...');
const work = path.join(res, '.patch-tmp');
if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
const { files } = asarExtract(orig, unpacked, work);
log(`解包完成:${files} 个文件`);

// 3) renderer/common.js 状态机补丁
log('应用渲染层补丁 ...');
let commonFails = 0;
const commonPath = path.join(work, 'renderer', 'common.js');
if (fs.existsSync(commonPath)) {
  let s = fs.readFileSync(commonPath, 'utf8');
  for (const [from, to] of COMMON_PATCHES) {
    const n = s.split(from).length - 1;
    if (n === 1) { s = s.replace(from, to); continue; }
    if (s.includes(to)) { continue; }
    commonFails++;
    log(`WARN common.js 字面量未命中(版本可能不匹配): ${from.slice(0, 60)}...`);
  }
  fs.writeFileSync(commonPath, s);
} else { log('WARN 未找到 renderer/common.js'); commonFails++; }

// 4) 激活 catch fallthrough(全 chunk)
let catchHits = 0;
const rdir = path.join(work, 'renderer');
if (fs.existsSync(rdir)) {
  for (const f of fs.readdirSync(rdir)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(rdir, f);
    let s = fs.readFileSync(p, 'utf8');
    const before = s.length;
    for (const [re, to] of CATCH_REGEXES) s = s.replace(re, to);
    if (s.length !== before) { fs.writeFileSync(p, s); catchHits++; }
  }
  log(`激活 fallthrough 已应用于 ${catchHits} 个 chunk`);
} else log('WARN 未找到 renderer 目录');

// 5) main.js 注入 hook
const mainPath = path.join(work, 'main', 'main.js');
if (fs.existsSync(mainPath)) {
  let ms = fs.readFileSync(mainPath, 'utf8');
  const a = ms.indexOf('/* xm-neutralize');
  if (a >= 0) { const b = ms.indexOf('})();', a); if (b >= 0) ms = ms.slice(0, a) + ms.slice(b + 5); }
  ms = MAIN_HOOK + '\n' + ms.replace(/^\s+/, '');
  fs.writeFileSync(mainPath, ms);
  log('主进程 hook 已注入 main/main.js');
} else { log('WARN 未找到 main/main.js'); commonFails++; }

// 6) 部署
if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
fs.cpSync(work, appDir, { recursive: true });
fs.rmSync(work, { recursive: true, force: true });

// 7) 校验标记
const ok = [];
const cs = fs.readFileSync(path.join(appDir, 'renderer', 'common.js'), 'utf8');
ok.push(['状态机恒VALID', cs.includes('checkActivationValid:()=>!0,') && cs.includes('k=()=>f.lX.VALID')]);
const ms2 = fs.readFileSync(path.join(appDir, 'main', 'main.js'), 'utf8');
ok.push(['主进程hook', ms2.includes('xm-neutralize')]);

console.log('\n===== 结果 =====');
for (const [k, v] of ok) log(`${v ? 'OK  ' : 'FAIL'} ${k}`);
if (commonFails) { log(`FAIL ${commonFails} 个补丁未命中 — Xmind 版本可能不兼容,请提交 issue 注明版本号。`); }
log(`完成!启动 Xmind 即生效(授权自动写入,无需手动激活)。`);
log(`回滚: node patch.js --restore`);
