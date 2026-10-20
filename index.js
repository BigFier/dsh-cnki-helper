/**
 * dsh-cnki-helper — 知网（CNKI）文献检索与 PDF 下载工具插件。
 *
 * 架构：直接调用 ctx.browser（dsh-builtin-browser 提供的 Service 接缝），
 * 复用 DSH 内置浏览器——同一窗口、同一登录态、实测零验证码。
 *
 * 为什么不再自带浏览器：
 * 2026-10-20 对照实验排除指纹伪装、登录态、内核、profile 历史四项后，
 * 确认只有 DSH 内置浏览器能稳定免验证码。
 *
 * 下载为什么用 iframe 而不是 ctx.browser.download：
 * 后者的实现是页面内 fetch(url,{credentials:'include'})，而知网下载接口在
 * bar.cnki.net，与 kns.cnki.net 不同源会被跨域拦。
 */
import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs'

export const name = 'dsh-cnki-helper'

/**
 * 依赖。
 *
 * 只把 `tools` 写成必需的。`browser`（ctx.browser）由 dsh-builtin-browser
 * 这个独立 bundle 提供，不是 dsh-base 自带；若写成必需 inject，目标机器没装
 * 时插件会永远等这个服务、静默不激活，工具也不出现，且没有任何报错。
 *
 * 因此 browser 不放进 inject，改在 apply 里用 ctx.get('browser') 取（Service
 * 文档给出的可选访问形式，取不到返回 undefined），工具里再给明确指引。
 */
export const inject = ['tools']

/**
 * 配置 schema。
 * 必须是 schemastery 的 z.object——传普通对象会让 loader 判为 unsupported
 * （配置无法投影成 schema），插件整条不激活、工具不出现。
 */
export const Config = z.object({
  downloadDir: z
    .string()
    .description('PDF 保存目录；留空则用当前工作目录下的「知网下载」')
    .default(''),
  maxPerRun: z
    .number()
    .description('单次最多下载篇数（知网过量下载口径：单次登录不超过 30 篇）')
    .default(10),
  delayMs: z.number().description('每篇之间的间隔毫秒数').default(8000),
})

const SEARCH_URL = (kw) =>
  `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(kw)}&korder=SU`

/** 最近一次检索结果，供 cnki_download 使用。 */
let lastSearch = []

function clean(s, n = 80) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}

/** 系统下载目录（iframe 触发的文件落在这里）。 */
const SYS_DL = path.join(os.homedir(), 'Downloads')

function snapshotDl() {
  const out = {}
  try {
    for (const f of readdirSync(SYS_DL)) {
      try {
        out[f] = statSync(path.join(SYS_DL, f)).size
      } catch {}
    }
  } catch {}
  return out
}

/** 等下载目录出现新文件且大小稳定。
 *
 * 注意：Windows 上 Electron/Chromium 下载时先写 `<guid>.tmp`，完成后才改名成
 * 正式文件名。所以不能把 .tmp 一律排除——否则会漏掉刚写完的文件。
 * 这里改为：接受 .tmp，但必须大小稳定且文件头是 %PDF 才认。
 */
async function waitNewDownload(before, timeoutSec = 90) {
  const t0 = Date.now()
  let cand = null
  let lastSize = -1
  while (Date.now() - t0 < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, 2000))
    const cur = snapshotDl()
    const fresh = Object.keys(cur).filter(
      (f) =>
        !(f in before) &&
        !/\.(part|crdownload)$/i.test(f) &&
        !f.startsWith('Unconfirmed'),
    )
    if (!fresh.length) continue
    fresh.sort(
      (a, b) =>
        statSync(path.join(SYS_DL, b)).mtimeMs - statSync(path.join(SYS_DL, a)).mtimeMs,
    )
    cand = fresh[0]
    const sz = cur[cand] ?? 0
    if (sz > 0 && sz === lastSize) {
      // 大小稳定后验一下文件头，确认写完了
      const full = path.join(SYS_DL, cand)
      let ok = false
      try {
        const head = readFileSync(full).subarray(0, 4).toString('latin1')
        ok = head === '%PDF'
      } catch {}
      if (ok) return full
      // 不是 PDF 说明还在写，继续等
    }
    lastSize = sz
  }
  return cand ? path.join(SYS_DL, cand) : null
}

/** 把下载到的文件改名移入目标目录，重名自动加序号。 */
function moveInto(srcPath, dir, fname) {
  if (!srcPath || !existsSync(srcPath)) return null
  let dest = path.join(dir, fname)
  if (existsSync(dest)) {
    const base = dest.replace(/\.pdf$/i, '')
    let n = 1
    while (existsSync(`${base}_${n}.pdf`)) n++
    dest = `${base}_${n}.pdf`
  }
  try {
    copyFileSync(srcPath, dest)
    try {
      unlinkSync(srcPath)
    } catch {}
    return dest
  } catch {
    return null
  }
}

/** 探测页面是否仍被验证码挡住；返回提示文案或 null。 */
const VERIFY_PROBE = `() => {
  const hasRows = !!document.querySelector('table.result-table-list tbody tr');
  const pdfBtn = [...document.querySelectorAll('a')]
    .some(a => /^(PDF下载|PDF 下载|CAJ下载)$/.test((a.innerText||'').trim()) && a.offsetParent);
  if (hasRows || pdfBtn) return null;
  const tip = [...document.querySelectorAll('div,span,p')]
    .map(e => (e.innerText||'').trim())
    .find(t => /请依次点击|向右滑动|拖动下方/.test(t) && t.length < 90);
  if (tip && !/验证成功/.test(tip)) return String(tip).slice(0, 60);
  if (document.querySelector('#tCaptchaDyMainWrap')) return '腾讯滑块';
  if (document.querySelector('.verifybox')) return 'kns 滑块';
  return null;
}`

export function apply(ctx, config) {
  const cfg = {
    downloadDir: config?.downloadDir || '',
    maxPerRun: Number(config?.maxPerRun) || 10,
    delayMs: Number(config?.delayMs) || 8000,
  }

  /**
   * 浏览器接缝是否就绪。
   * ctx.browser 由 dsh-builtin-browser 提供，是独立 bundle，不一定装了。
   * 取不到时不能直接抛错，否则三个工具全废；改为返回明确的修复指引。
   */
  const MISSING_BROWSER =
    '缺少浏览器能力：ctx.browser 不可用。\n\n' +
    '本插件依赖 DSH 的 dsh-builtin-browser（提供 ctx.browser 与 browser_* 工具），' +
    '它不是 dsh-base 自带的独立 bundle。\n\n' +
    '修复：在 DSH 里安装 dsh-builtin-browser，确认它出现在 profile 的 ' +
    'dsh.profile.bundles 里，然后重启 DSH 宿主。\n' +
    '装好之后 cnki_status 会显示「浏览器：DSH 内置浏览器」。'

  function browser() {
    // 可选访问：Service 文档写的 ctx.get("browser")，未注册时返回 undefined。
    let b
    try {
      b = typeof ctx.get === 'function' ? ctx.get('browser') : ctx.browser
    } catch {
      b = undefined
    }
    if (!b || typeof b.open !== 'function') throw new Error(MISSING_BROWSER)
    return b
  }

  function hasBrowser() {
    try {
      const b = typeof ctx.get === 'function' ? ctx.get('browser') : ctx.browser
      return !!b && typeof b.open === 'function'
    } catch {
      return false
    }
  }

  /**
   * 浏览器会话。
   *
   * 关键：用 exec.agent.id（DSH 会话 id）作为 open 的 label——这正是
   * dsh-builtin-browser 工具层 taskKey() 用的 key，provider 按 label 复用
   * 同一会话。否则会新开一个空 profile 的浏览器，拿不到已登录的知网态。
   */
  const sessions = new Map()
  async function ensureSession(exec) {
    const key = exec?.agent?.id ?? 'default'
    const hit = sessions.get(key)
    if (hit) return hit
    const s = await browser().open(key)
    sessions.set(key, s)
    return s
  }

  async function evalJs(exec, js, arg) {
    const s = await ensureSession(exec)
    // ⚠ CDP 的 Runtime.evaluate 只可靠带回原始值；返回对象时会丢成 {}。
    // 所以统一把脚本包成 JSON.stringify(...) 再取回，由本层解析。
    const wrapped = `(() => { try { const r = (${js})(${arg !== undefined ? JSON.stringify(arg) : ''}); return JSON.stringify({ ok: 1, v: r === undefined ? null : r }); } catch (e) { return JSON.stringify({ ok: 0, e: String(e && e.message || e) }); } })()`
    const res = await browser().execute(s, { script: wrapped })
    let raw = res
    if (res && typeof res === 'object' && 'ok' in res) {
      if (!res.ok) throw new Error(`页面脚本异常：${String(res.exception).slice(0, 160)}`)
      raw = res.value
    }
    if (typeof raw === 'string') {
      try {
        const j = JSON.parse(raw)
        if (j.ok === 0) throw new Error(`页面脚本抛错：${String(j.e).slice(0, 160)}`)
        return j.v
      } catch (e) {
        if (e.message.startsWith('页面脚本抛错')) throw e
        return raw
      }
    }
    // 退回：可能是原始值或空对象
    if (raw && typeof raw === 'object' && Object.keys(raw).length === 0) return null
    return raw
  }

  async function goto(exec, url) {
    const s = await ensureSession(exec)
    await browser().navigate(s, { url })
  }

  function resolveDir() {
    if (cfg.downloadDir) return cfg.downloadDir
    const base = process.cwd() || os.homedir()
    return path.join(base, '知网下载')
  }

  // 各工具返回的文本字段名不同（text / output / report），统一按优先级取，
  // 否则某个工具会渲染成空字符串。
  const pickText = (v) => {
    if (v == null) return ''
    if (typeof v === 'string') return v
    for (const k of ['report', 'text', 'output']) {
      if (typeof v[k] === 'string' && v[k].length) return v[k]
    }
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
  const textOutput = (schema) => ({
    schema,
    render: (_a, v) => [{ type: 'text', text: pickText(v) }],
  })

  // ---------------- cnki_search ----------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'cnki_search',
      description:
        '在知网（CNKI）检索中文文献。复用 DSH 内置浏览器的登录态（实测零验证码），' +
        '返回标题/作者/年期。结果留在会话内，供 cnki_download 按序号下载。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '检索词（中文）' },
          limit: { type: 'number', description: '取前几条，默认 20' },
        },
        required: ['keyword'],
      },
      output: textOutput({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          entries: { type: 'array', items: { type: 'object' } },
          text: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        const kw = String(args?.keyword ?? '').trim()
        const limit = Math.min(Number(args?.limit) || 20, 50)
        if (!kw) throw new Error('keyword 不能为空')

        await goto(exec, SEARCH_URL(kw))
        await new Promise((r) => setTimeout(r, 4500))

        const warn = await evalJs(exec, VERIFY_PROBE)
        if (warn) {
          return {
            ok: false,
            count: 0,
            entries: [],
            text: `被验证码拦住：${warn}\n请在浏览器窗口里手动完成验证后重试。`,
          }
        }

        const rows = await evalJs(
          exec,
          `() => {
            const trs = [...document.querySelectorAll('table.result-table-list tbody tr')];
            return trs.slice(0, ${limit}).map(tr => {
              const a = tr.querySelector('td.name a') || tr.querySelector('.name a');
              if (!a) return null;
              const pick = s => (tr.querySelector(s)?.innerText || '').trim().replace(/\\s+/g,' ');
              return {
                title: (a.innerText || '').trim().replace(/\\s+/g,' '),
                href: a.href,
                author: pick('td.author'),
                date: pick('td.date'),
              };
            }).filter(Boolean);
          }`,
        )

        lastSearch = Array.isArray(rows) ? rows : []
        const lines = lastSearch.map(
          (r, i) => `${i + 1}. ${r.title} | ${r.author || '-'} | ${r.date || '-'}`,
        )
        return {
          ok: true,
          count: lastSearch.length,
          entries: lastSearch,
          text: `检索「${kw}」：${lastSearch.length} 条\n\n${lines.join('\n')}`,
        }
      },
    }),
  )

  // ---------------- cnki_download ----------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'cnki_download',
      description:
        '按序号下载知网 PDF。序号来自最近一次 cnki_search。支持 "1"、"3-5"、"0"（全部）。' +
        '用详情页内注入 iframe 触发下载，文件落系统下载目录后改名归位，不弹「另存为」。' +
        '受 maxPerRun 限制（默认 10 篇），篇间间隔 delayMs（默认 8 秒）。',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            description: '序号或区间："1"、"3-5"、"0"',
            default: '1',
          },
        },
      },
      output: textOutput({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          succeeded: { type: 'number' },
          attempted: { type: 'number' },
          text: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        const rng = String(args?.range ?? '1').trim() || '1'
        if (!lastSearch.length) {
          return {
            ok: false,
            succeeded: 0,
            attempted: 0,
            text: '还没有检索结果，先调用 cnki_search。',
          }
        }

        let picked = []
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(rng)
        if (m) {
          const a = Number(m[1])
          const b = Number(m[2])
          for (let i = a; i <= Math.min(b, lastSearch.length); i++) if (i > 0) picked.push(i)
        } else if (rng === '0') {
          picked = lastSearch.map((_, i) => i + 1)
        } else {
          const i = Number(rng)
          if (i > 0 && i <= lastSearch.length) picked.push(i)
        }
        if (!picked.length) {
          return {
            ok: false,
            succeeded: 0,
            attempted: 0,
            text: `序号无效（共 ${lastSearch.length} 条）`,
          }
        }

        const capped = picked.slice(0, cfg.maxPerRun)
        const cappedNote =
          capped.length < picked.length
            ? `\n注意：本次请求 ${picked.length} 篇，按 maxPerRun=${cfg.maxPerRun} 截断为 ${capped.length} 篇。`
            : ''

        const dir = resolveDir()
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        const log = []
        let okCount = 0
        for (let k = 0; k < capped.length; k++) {
          const seq = capped[k]
          const item = lastSearch[seq - 1]
          log.push(`[${k + 1}/${capped.length}] ${item.title.slice(0, 46)}`)
          const before = snapshotDl()
          try {
            await goto(exec, item.href)
            await new Promise((r) => setTimeout(r, 3500))

            const warn = await evalJs(exec, VERIFY_PROBE)
            if (warn) {
              log.push(`    ✘ 被验证码拦住（${warn}），请手动验证后重试`)
              continue
            }

            const triggered = await evalJs(
              exec,
              `() => {
                const as = [...document.querySelectorAll('a')]
                  .filter(x => /^(PDF下载|PDF 下载)$/.test((x.innerText||'').trim()));
                const vis = as.filter(a => a.offsetParent);
                if (!vis.length) return null;
                const href = vis[0].href;
                document.querySelectorAll('iframe[data-cnki-dl]').forEach(f => f.remove());
                const f = document.createElement('iframe');
                f.setAttribute('data-cnki-dl', '1');
                f.style.display = 'none';
                f.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-downloads');
                f.src = href;
                document.body.appendChild(f);
                return href.slice(0, 80);
              }`,
            )
            if (!triggered) {
              log.push('    ✘ 无 PDF 下载按钮（该刊可能未授权）')
              continue
            }

            const got = await waitNewDownload(before, 90)
            if (!got) {
              log.push('    ✘ 触发后下载目录无新文件（多为该刊未授权或收录空缺）')
              continue
            }
            const fname =
              clean(`${item.title}_${item.author || ''}`, 90).replace(/_+$/, '') + '.pdf'
            const finalPath = moveInto(got, dir, fname)
            const sz = finalPath && existsSync(finalPath) ? statSync(finalPath).size : 0
            if (sz < 1024) {
              log.push(`    ✘ 文件异常（${sz} B）`)
              continue
            }
            let head = Buffer.alloc(0)
            try {
              head = readFileSync(finalPath).subarray(0, 5)
            } catch {}
            if (head.toString('latin1', 0, 4) !== '%PDF') {
              log.push(`    ✘ 不是 PDF（头 ${JSON.stringify(head.toString('latin1'))}）`)
              continue
            }
            okCount++
            log.push(`    ✔ ${Math.round(sz / 1024)} KB → ${path.basename(finalPath)}`)
          } catch (e) {
            log.push(`    ✘ ${String(e.message || e).split('\n')[0].slice(0, 120)}`)
          }
          if (k < capped.length - 1) await new Promise((r) => setTimeout(r, cfg.delayMs))
        }

        return {
          ok: okCount > 0,
          succeeded: okCount,
          attempted: capped.length,
          text: `下载完成：成功 ${okCount}/${capped.length}\n保存到：${dir}${cappedNote}\n\n${log.join('\n')}`,
        }
      },
    }),
  )

  // ---------------- cnki_status ----------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'cnki_status',
      description:
        '检查知网助手的运行状态：浏览器接入方式、下载目录与已下载数量、限速设置、' +
        '以及内置浏览器当前是否已登录知网（这决定会不会遇到验证码）。',
      parameters: { type: 'object', properties: {} },
      output: textOutput({
        type: 'object',
        properties: { ok: { type: 'boolean' }, report: { type: 'string' } },
      }),
      async execute(_args, exec) {
        const dir = resolveDir()
        let n = 0
        try {
          n = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).length
        } catch {}

        // 没装 dsh-builtin-browser 时，先给出结论而不是让人去猜。
        if (!hasBrowser()) {
          return {
            ok: false,
            report: [
              '浏览器：❌ ctx.browser 不可用',
              `下载目录：${dir}  ${n} 个 PDF`,
              `限速：单次最多 ${cfg.maxPerRun} 篇，篇间 ${cfg.delayMs} ms`,
              '',
              MISSING_BROWSER,
            ].join('\n'),
          }
        }

        const lines = [
          '浏览器：DSH 内置浏览器（ctx.browser，与 browser_* 工具共享会话）',
          `下载目录：${dir}  ${n} 个 PDF`,
          `限速：单次最多 ${cfg.maxPerRun} 篇，篇间 ${cfg.delayMs} ms`,
        ]

        try {
          await goto(
            exec,
            'https://kns.cnki.net/kns8s/defaultresult/index?kw=test&korder=SU',
          )
          await new Promise((r) => setTimeout(r, 4000))
          const st = await evalJs(
            exec,
            `() => {
              const b = (document.body?.innerText || '');
              return {
                logged: /中山大学|梧州学院|退出|我的图书馆/.test(b.slice(0, 1200)),
                head: b.slice(0, 120).replace(/\\s+/g,' ').trim(),
                rows: document.querySelectorAll('table.result-table-list tbody tr').length,
              };
            }`,
          )
          lines.push(
            `知网登录态：${st?.logged ? '✔ 已登录' : '⚠ 未检出（可能需手动登录）'}`,
          )
          lines.push(`检索结果行数：${st?.rows ?? 0}`)
          lines.push(`页面首行：${(st?.head || '-').slice(0, 60)}`)
        } catch (e) {
          lines.push(`页面探测失败：${String(e.message || e).split('\n')[0].slice(0, 120)}`)
        }

        return { ok: true, report: lines.join('\n') }
      },
    }),
  )
}
