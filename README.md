# Xmind Local Patch

面向 Electron 应用的逆向工程研究,实现了 Xmind 全部本地功能(pro+)解锁与自动授权,无需登录、无需输入序列号。(实测 v26.05.01107)

## 控制流

```text
patch.js (zero-dependency)
      │
      ├─ locate resources/app.asar → backup → app.asar.orig
      ├─ asar extract (pure node unpacker, 6931 files)
      │
      ▼
renderer patches (static)
      │
      ├─ common.js
      │     ├─ status(d) → computed(() => VALID)
      │     ├─ perMachineLicenseStatus(w) → VALID
      │     ├─ checkActivationValid → () => true
      │     ├─ validatePerMachineLicenseData(k) → VALID
      │     └─ RSA verify → const a = !0
      │
      ├─ 34 activation chunks
      │     └─ catch → strip server-error guards → offline fallthrough
      │
      └─ deploy → resources/app (Electron prefers dir over asar)

之后 Xmind.exe 启动
      │
      ▼
loads main/main.js (bytenode stub)
      │
      ▼
xm-neutralize v6 prefix executes
      │
      ├─ EPIPE immunity (stdout/stderr)
      ├─ crypto.createVerify → verify() = true
      │
      ▼
main.bytecode loads (original logic untouched)
      │
      ▼
app ready
      │
      ├─ protocol.handle("https")
      │     ├─ /_res/verify-sme-license  → reject("xm-offline")
      │     └─ /_api/license-activations → reject("xm-offline")
      │           (60s 复核走离线容错分支,弹窗诱因消除)
      │
      ├─ BrowserWindow.prototype.loadURL
      │     └─ dialog-license / dialog-enterpassword → close()
      │
      ├─ dialog.showMessageBox(Sync)
      │     └─ license/serial text → swallowed
      │
      └─ auto-activation (every window)
            └─ executeJavaScript
                  ├─ GET /pinia/store/state
                  ├─ key present? → return
                  └─ POST /pinia/store/mutations
                        └─ updateRawPerMachineLicenseData
                              └─ { key, email, data } → persisted
```

## License Format

```text
key 清洗后 225 字符,字符集 [A-Z0-9](Base32 大写表)
  [0]       'X'                固定魔数
  [1]       type               A / S(B/C 内嵌公钥为空串)
  [2..4)    vendorName
  [4]       majorVersion       jp('H') = 17,须满足 17 + 9 === "26"
  [5]       minorVersion
  [6]       licenseeType
  [7..9)    yearsOfUpgrade
  [9]       expireMonths       '0' = 永不过期
  [10..12)  reserved
  [12..20)  free(签名覆盖)
  [20..225) signature          RSA-1024-SHA256 的 Base32

signed payload = key[0..20] + email(lowercase) + verifierSuffix(type 定长魔串)
verify         = crypto.createVerify("RSA-SHA256") against 内嵌 1024-bit PEM
```

## 安装

```bat
node patch.js                :: 自动探测已安装的 Xmind
node patch.js D:\Xmind       :: 指定目录
node patch.js --restore      :: 还原原版
```

无 Node.js 时双击 `应用补丁.bat`(自动借用 Xmind 自带 Electron 运行时)。

## Disclaimer

本项目仅用于 Electron 应用逆向工程、授权机制分析与软件安全学习。

Xmind 仅作为研究对象,本项目与 Xmind 官方无关。

## Credits

- [lwtw123456/Xmind-Hack](https://github.com/lwtw123456/Xmind-Hack) — native hook 路线的同类研究,本项目 `protocol.handle` 拦截思路受其启发
- bytenode — 主进程字节码保护结构分析对象

## License

MIT
