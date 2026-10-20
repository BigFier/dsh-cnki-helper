# dsh-cnki-helper

在 DSH 会话里检索知网，按序号下载 PDF。不装额外浏览器、不点验证码、不弹「另存为」。

知网下载这件事，麻烦从来不在「能不能下」，而在下面这几处：

- **验证码。** 检索页出滑块，详情页出点选（「请依次点击【这,歌,房】」）。脚本一碰就被拦。
- **下载不下来。** 点 PDF 下载跳「来源应用不正确(01)」。这不是权限问题，是 Referer 缺失。
- **文件不知道去哪了。** 弹一个 Windows「另存为」对话框，得有人点「保存」；点「取消」文件就被删掉。
- **批量做不了。** 一篇一篇点，点到第十篇就烦了。

这个插件把这几件事做进了一个 DSH 工具里。装好之后，你在会话里说一句话就行。

---

## AI 能帮你做到什么

### 场景一：找几篇文献，顺手把 PDF 拿到本地

> **你：** 帮我下三篇关于日本文学批评的论文，要能打开的那种。

agent 会调 `cnki_search`，拿回标题、作者、年期，然后 `cnki_download`。你什么都不用管。

```
检索「日本文学」：5 条

1. 20世纪80年代初日本"文学者反核运动"的兴起及其引发的思想论争 | 戴宇;李萌 | 2026-09-05
2. 《挪威的森林》对日本文学的影响和传承作用 | 喻苏苏;刘洪昊 | 2026-08-30
3. 四六文与日本文学的关系 | 芳贺矢一;蒙显鹏 | 2026-08-26
```

```
下载完成：成功 1/1
保存到：D:\DSH_Data\profiles\desktop\知网下载

[1/1] 四六文与日本文学的关系
    ✔ 3001 KB → 四六文与日本文学的关系_芳贺矢一;蒙显鹏.pdf
```

**全程没有验证码。** 不是运气好——是它用的是你已经登录的那个浏览器。

### 场景二：下不了的那篇，它知道为什么

> **你：** 第二篇失败了，怎么回事？

有些刊物账户没有授权，PDF 按钮点了没反应。agent 会告诉你是「该刊未授权」，而不是让你去猜是不是脚本坏了。

这不是 bug，是权限。换一篇就行。

### 场景三：批量跑，不用守着

> **你：** 第 1 到第 8 篇都下了。

`range` 支持 `1`、`3-5`、`0`（全部）。篇与篇之间默认隔 8 秒，一次最多 10 篇——这两个数不是随手写的，是知网的过量下载口径（单次登录 30 篇、24 小时 90 篇封 IP 24 小时）。写在代码里，不靠自觉。

---

## 它是怎么工作的

```
你的 DSH 会话
   ↓
cnki_search / cnki_download（插件注册的工具）
   ↓
ctx.browser  ←  DSH 内置浏览器，复用你的登录态
   ↓
详情页注入隐藏 iframe  →  文件落系统下载目录  →  改名归位
```

三个关键点，都不是随便选的：

**用内置浏览器，不用自己开一个。**
这是实测出来的。同一天、同一台机器、同一个中山大学账号，试过四种组合：自带 Firefox（invisible_playwright）、无伪装的系统 Edge、Firefox、Chromium——**全部触发验证码**。只有 DSH 内置浏览器连续多篇零验证。

指纹伪装、登录态、浏览器内核、profile 历史，这四项都用对照实验排除了。剩下唯一没排除的是出口 IP，但至少可以确定：**问题不在你用的浏览器上**。

**下载用 iframe，不用 `ctx.browser.download`。**
后者的实现是页面内 `fetch(url, {credentials: 'include'})`，而知网下载接口在 `bar.cnki.net`，与 `kns.cnki.net` 不同源，会被跨域拦。iframe 带 Referer 且同源，能过。

**文件从系统下载目录捞回来。**
iframe 触发后 Chromium 先写一个 `<guid>.tmp`，写完才改名。所以要按「大小稳定 + 文件头是 `%PDF`」两个条件判断，不能一看是 `.tmp` 就跳过。

---

## 安装

需要 DSH 桌面端 0.2.0-rc.1 或以上。

把下面这段整个发给你的 AI（DSH、Claude Code、Cursor 都行），它会自己做完：

```
帮我安装 dsh-cnki-helper 这个 DSH 插件，并实测确认能用。

仓库：https://github.com/BigFier/dsh-cnki-helper

你要自动完成：
1. 克隆仓库到本地任意目录
2. 用 plugin_manager 的 install_bundle 安装，target 填克隆下来的目录
3. 安装完成后，确认 profile 的 package.json 里 dsh.profile.bundles 含有 dsh-cnki-helper
   —— install_bundle 不一定帮你写这一条，没有就手动加
4. 重启 DSH 宿主
5. 重启后调一次 cnki_status，把输出给我看

遇到报错自己排查，修不了再问我。说话简单直白。
```

> **为什么第 3 步要单独检查？** 因为 `install_bundle` 只负责装依赖和建链接，不负责把包名写进 `dsh.profile.bundles`。少了这一步，重启后插件不会加载，工具也不会出现——而且没有任何报错。

手动装也行，两条命令：

```bash
git clone https://github.com/BigFier/dsh-cnki-helper.git
# 然后在 DSH 里让 agent 执行 plugin_manager install_bundle <路径>
```

---

## 四个工具

| 工具 | 参数 | 干什么 |
|---|---|---|
| `cnki_search` | `keyword`、`limit?` | 检索，返回标题/作者/年期 |
| `cnki_download` | `range` | `1`、`3-5`、`0`（全部） |
| `cnki_status` | — | 检查登录态、下载目录、限速 |
| `cnki_login` | — | 手动登录（一般用不上） |

一般只用前两个。

### 配置项

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-cnki-helper
  name: 'dsh-cnki-helper'
  config:
    downloadDir: 'D:\我的文献'   # 留空则用 <cwd>/知网下载
    maxPerRun: 10                # 单次最多几篇
    delayMs: 8000                # 篇间隔，毫秒
```

> ⚠️ 这里 `config` 是**整体替换，不是深合并**。只写一个字段会把另外两个默认值顶掉。三个都要写。

---

## 踩过的坑

这些都是实际撞上、改代码改出来的，不是查文档抄的。

**不导出 Config 会导致插件静默不激活。**
最开始没写 Config，也试过写成普通对象。两种情况下 `cordis_inspect_query` 都报 `status: "unsupported"`，插件整条不加载、工具不出现，**没有任何错误提示**。必须用 schemastery：

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({ ... })
```

**CDP 的 `execute` 带不回对象。**
这是最隐蔽的一个。`ctx.browser.execute()` 返回 `{ok: true, value}`，但脚本返回对象时 `value` 会是 `{}`——连 `() => 1+1` 都返回 `{}`。表现是工具调用成功、不报错、数据全空。

解法是把脚本包成 `JSON.stringify(...)` 再取：

```js
const wrapped = `(() => { try { const r = (${js})(${arg}); return JSON.stringify({ok:1, v: r ?? null}); } catch(e) { return JSON.stringify({ok:0, e: String(e?.message||e)}); } })()`
```

**session 要用 DSH 会话 id 当 key。**
`ctx.browser.open(label)` 的 label 不是随便写的。写死了拿不到登录态；要用 `exec.agent.id`，和 `browser_*` 工具层的 `taskKey()` 保持一致，才会复用同一个浏览器会话。

**Windows 下载先写 `.tmp`。**
过滤掉 `.tmp` 会漏掉刚写完的文件，误报「下载目录无新文件」。实测过一个 3001 KB 的 `.tmp`，内容完整、文件头就是 `%PDF`。

**别用 PowerShell 的 `-Raw` 读写含中文的源码。**
UTF-8 中文会被切坏——字符串丢引号、语法直接报错。用文件工具或 Node 做字节级复制。这个坑浪费了半小时。

**`cordis.patch.yml` 里一行被压扁会让 `plugin_manager` 整个不可用。**
`# 注释...# - id: system-prompt` 挤在一行时，`#` 会吞掉整行，后面的 `config:` 变成孤立键，YAML 报 `duplicated mapping key`。报错信息指向行号，但真正的问题在上一行。

---

## 已知限制

- **只支持 Windows。** 下载目录、路径分隔符都是按 Windows 写的。理论上改几行能在 macOS/Linux 跑，但没测过。
- **依赖 DSH 内置浏览器。** 这是它免验证码的原因，也是它的边界——内置浏览器出问题，插件就不能用。
- **授权范围决定能不能下。** 机构账号没订的刊物，PDF 按钮点了不会有文件。这不是插件的问题。
- **没有进度显示。** 下载 8 篇的时候，工具会一直卡到结束才返回。要中途知道进度，只能拆成几次调。

---

## 合规

中山大学图书馆的规定写得很明确：**禁止使用软件或下载工具下载电子资源，禁止批量下载**。

本插件按个人查阅的强度设计了硬约束（单次 ≤10 篇、间隔 8 秒），但**这不改变上面的规定**。用它做超出个人阅读范围的批量采集，后果由使用者承担：知网对过量下载的处理是封 IP 24 小时，并记录一次违规；机构层面可能追责到全校。

建议：一次不超过 10 篇，下完就停。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目是第三方工具，与同方知网（北京）技术有限公司无隶属关系，也未获其授权或背书。`cnki` 只说明它服务于这个站点。

## 相关

- [DSH 桌面端](https://github.com/BigFier) — 这个插件运行的宿主
- [kh-coder-headless](https://github.com/BigFier/kh-coder-headless) — 同一作者的另一个项目，把 KH Coder 做成命令行
