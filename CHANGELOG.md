# 更新记录

## 1.1.0 — 2026-10-20

重写为基于 `ctx.browser` 的实现，不再自带浏览器。

**变化**

- 浏览器从独立 Firefox（invisible_playwright）改为复用 DSH 内置浏览器
- 移除 Python 依赖：不再需要 invisible_playwright、ddddocr、numpy、opencv
- 移除验证码求解器（滑块/点选）
- 下载改为详情页注入 iframe 触发，不再用鼠标点按钮
- 实测检索零验证码，下载 1/1 成功，文件头 `%PDF-1.6` 校验通过

**修复**

- `Config` 改为 schemastery 的 `z.object`，修掉插件被判定为 `unsupported`、静默不激活的问题
- `execute` 返回值改为 `JSON.stringify` 包裹，修掉对象被吞成 `{}`、数据全空的问题
- session key 改为 `exec.agent.id`，修掉拿不到登录态的问题
- 下载轮询不再过滤 `.tmp`，改为按「大小稳定 + `%PDF` 文件头」判定

**已知问题**

- 仅在 Windows 上测试
- 下载期间无进度输出，多篇时需等全部结束才返回

## 1.0.0 — 2026-10-18

首个可用版本。

- 四个工具：`cnki_search`、`cnki_download`、`cnki_login`、`cnki_status`
- 基于 invisible_playwright（Firefox）+ ddddocr，自动过 kns 滑块、腾讯 tcaptcha、点选验证码
- 下载用真实鼠标坐标点击 PDF 按钮，监视系统下载目录后改名归位
- 实测批量下载 3/3 成功，单篇验证码 7–10 秒自动通过
