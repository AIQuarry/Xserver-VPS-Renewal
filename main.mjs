import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({ defaultViewport: { width: 1080, height: 1024 }, args })
const [page] = await browser.pages()
await page.setUserAgent((await browser.userAgent()).replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

async function solveTurnstileV2(sitekey, pageUrl) {
    const apiKey = process.env.TWOCAPTCHA_KEY
    console.log('→ 提交 createTask API v2，sitekey:', sitekey)
    const createRes = await fetch('https://api.2captcha.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientKey: apiKey,
            task: { type: 'TurnstileTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey }
        })
    })
    const createJson = await createRes.json()
    if (createJson.errorId !== 0) throw new Error('createTask 错误: ' + createJson.errorCode)
    const taskId = createJson.taskId
    console.log('→ Task ID:', taskId)

    for (let i = 0; i < 30; i++) {
        await setTimeout(5000)
        const res = await fetch('https://api.2captcha.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, taskId })
        })
        const j = await res.json()
        if (j.errorId !== 0) throw new Error('getTaskResult 错误: ' + j.errorCode)
        if (j.status === 'ready') {
            console.log('→ 获取 token 成功')
            return j.solution.token
        }
        console.log('…等待中', i + 1)
    }
    throw new Error('2Captcha v2 获取超时')
}

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) await page.authenticate({ username, password })
    }

    // 登录与导航
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // 普通图形验证码
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body })
        .then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

    // Debug: 列印 frames
    console.log('---- frames ----')
    for (const f of page.frames()) console.log('•', f.url())
    console.log('----------------')

    // 检测 Turnstile iframe
    const cfFrame = page.frames().find(f =>
        f.url().includes('challenges.cloudflare.com') &&
        f.url().includes('/turnstile/if/')
    )
    if (cfFrame) {
        console.log('检测到 Turnstile iframe:', cfFrame.url())
        const sitekey = (cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//) || [])[1]
        if (!sitekey) throw new Error('提取 sitekey 失败')
        const token = await solveTurnstileV2(sitekey, page.url())
        // 注入并提交
        await page.evaluate(t => {
            const inp = document.querySelector('input[name="cf-turnstile-response"]') ||
                (() => {
                    const i = document.createElement('input')
                    i.type = 'hidden'
                    i.name = 'cf-turnstile-response'
                    document.forms[0].appendChild(i)
                    return i
                })()
            inp.value = t
            document.forms[0].submit()
        }, token)
        await page.waitForNavigation({ waitUntil: 'networkidle2' })
    } else {
        console.log('⚠️ 未检测到 Turnstile iframe，跳过')
    }

    // 点击续费按钮
    const btn = await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 30000 }).catch(() => null)
    if (!btn) throw new Error('无法找到续费按钮')
    await btn.click()
    console.log('续费按钮点击成功')
} catch (e) {
    console.error('发生错误:', e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
