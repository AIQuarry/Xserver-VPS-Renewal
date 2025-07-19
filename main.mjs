import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    // 登录 & 导航到续费页
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
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body
    }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

    // ---- 调试：打印所有 frame URLs ----
    console.log('---- 当前所有 frame URLs ----')
    for (const f of page.frames()) {
      console.log('•', f.url())
    }
    console.log('-----------------------------')

    // Cloudflare Turnstile 检测 & 处理
    const cfFrame = page.frames().find(f =>
      f.url().includes('challenges.cloudflare.com') &&
      f.url().includes('/turnstile/if/')
    )

    if (cfFrame) {
        console.log('检测到 Turnstile frame →', cfFrame.url())

        // 从 frame.url() 中提取 sitekey
        const sitekeyMatch = cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//)
        const sitekey = sitekeyMatch ? sitekeyMatch[1] : null
        console.log('提取到 sitekey:', sitekey)

        if (sitekey) {
            const apiKey = process.env.TWOCAPTCHA_KEY
            const pageUrl = page.url()

            // 提交到 2Captcha
            const submitRes = await fetch(
              `http://2captcha.com/in.php?key=${apiKey}&method=turnstile&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}`
            )
            const submitText = await submitRes.text()
            if (!submitText.startsWith('OK|')) throw new Error('2Captcha 提交失败: ' + submitText)
            const captchaId = submitText.split('|')[1]

            // 轮询获取 token
            let token = null
            for (let i = 0; i < 30; i++) {
                await setTimeout(5000)
                const pollRes = await fetch(
                  `http://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}`
                )
                const pollText = await pollRes.text()
                if (pollText.startsWith('OK|')) {
                    token = pollText.split('|')[1]
                    break
                }
            }
            if (!token) throw new Error('2Captcha Turnstile 超时')

            // 注入 token 并提交表单
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
            console.log('Turnstile 验证完成')
        }
    }
    else if (await page.$('label.cb-lb input[type="checkbox"]')) {
        console.log('检测到内联 Turnstile，点击复选框…')
        await page.click('label.cb-lb input[type="checkbox"]')
        await page.waitForSelector('#success', { timeout: 30000 })
        console.log('内联 Turnstile 验证完成')
    }
    else {
        console.log('⚠️ 未检测到任何 CF 验证，跳过这一步')
    }

    // 等待并点击最终续费按钮，30 秒超时退出
    const btn = await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 30000 }).catch(() => null)
    if (btn) {
        await btn.click()
        console.log('点击续费按钮 ✔️')
    } else {
        throw new Error('30 秒内未检测到续费按钮')
    }

} catch (e) {
    console.error('发生错误:', e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
