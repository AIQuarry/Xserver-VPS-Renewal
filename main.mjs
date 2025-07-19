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

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // === Cloudflare Turnstile 检测和处理 ===
    const hasIframeTurnstile = await page.$('iframe[src*="turnstile"]')
    if (hasIframeTurnstile) {
        const sitekey = await page.$eval('iframe[src*="turnstile"]', iframe => {
            const src = iframe.getAttribute('src')
            const match = src.match(/[?&]k=([^&]+)/)
            return match ? match[1] : null
        })

        if (sitekey) {
            const url = page.url()
            const apiKey = process.env.TWOCAPTCHA_KEY
            const res = await fetch(`http://2captcha.com/in.php?key=${apiKey}&method=turnstile&sitekey=${sitekey}&pageurl=${url}`)
            const text = await res.text()
            const [, captchaId] = text.split('|')

            let token = null
            for (let i = 0; i < 30; i++) {
                await setTimeout(5000)
                const poll = await fetch(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}`)
                const pollText = await poll.text()
                if (pollText.startsWith('OK|')) {
                    token = pollText.split('|')[1]
                    break
                }
            }

            if (token) {
                await page.evaluate(token => {
                    document.querySelector('input[name="cf-turnstile-response"]').value = token
                }, token)
                await page.evaluate(() => {
                    document.querySelector('form').submit()
                })
                await page.waitForNavigation({ waitUntil: 'networkidle2' })
            } else {
                throw new Error('2Captcha Turnstile 超时')
            }
        }
    } else if (await page.$('label.cb-lb input[type="checkbox"]')) {
        // === 内联版 Turnstile ===
        await page.click('label.cb-lb input[type="checkbox"]')
        await page.waitForSelector('#success', { timeout: 15000 })
    }

    // === 普通验证码 ===
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

    // === 等待最终按钮点击，如果30秒没检测到就退出 ===
    const buttonSelector = 'text=無料VPSの利用を継続する'
    const finalButton = await page.waitForSelector(buttonSelector, { timeout: 30000 }).catch(() => null)

    if (finalButton) {
        await finalButton.click()
    } else {
        throw new Error('30秒内未检测到最终按钮，脚本终止')
    }
} catch (e) {
    console.error('发生错误:', e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
