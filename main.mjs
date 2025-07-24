import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

// --- 2Captcha 配置 ---
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY

/**
 * 轮询查询 2Captcha API 获取已解决的结果
 * @param {string} captchaId - 从 /in.php 获取的验证码任务ID
 * @returns {Promise<string>} - 解决后的令牌 (token) 或验证码文本
 */
async function pollFor2CaptchaResult(captchaId) {
    console.log(`任务提交至 2Captcha, ID: ${captchaId}，正在等待服务器处理...`)
    
    // 初始等待时间，给服务器接收任务的时间
    await setTimeout(20000)

    while (true) {
        try {
            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`)
            const result = await resultResponse.json()

            if (result.status === 1) {
                console.log(`2Captcha 解决成功！结果: ${result.request.substring(0, 30)}...`)
                return result.request
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                throw new Error(`在 2Captcha 解决过程中发生错误: ${result.request}`)
            }

            console.log('2Captcha 验证码尚未解决，10秒后重试...')
            await setTimeout(10000)
        } catch (error) {
            console.error("轮询 2Captcha 结果时发生网络错误:", error)
            await setTimeout(10000)
        }
    }
}

/**
 * 使用 2Captcha 解决 Cloudflare Turnstile
 * @param {string} sitekey - 从页面 HTML 中获取的 data-sitekey
 * @param {string} pageUrl - 出现 Turnstile 的页面的完整URL
 * @param {string} action - (可选) 从 data-action 属性获取的值
 * @param {string} cdata - (可选) 从 data-cdata 属性获取的值
 * @returns {Promise<string>} - 解决后的 Turnstile 令牌
 */
async function solveTurnstile(sitekey, pageUrl, action, cdata) {
    console.log('正在请求 2Captcha 解决 Turnstile...')
    const payload = new URLSearchParams({
        key: TWOCAPTCHA_API_KEY,
        method: 'turnstile',
        sitekey: sitekey,
        pageurl: pageUrl,
        json: 1
    })
    if (action) {
        payload.append('action', action)
        console.log(`包含 action: ${action}`)
    }
    if (cdata) {
        payload.append('cdata', cdata)
        console.log(`包含 cdata: ${cdata}`)
    }

    const sendResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    })

    const sendResult = await sendResponse.json()
    if (sendResult.status !== 1) {
        throw new Error(`向 2Captcha 发送 Turnstile 请求失败: ${sendResult.request}`)
    }
    return pollFor2CaptchaResult(sendResult.request)
}

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

    // 登录页面
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // 进入服务器详情页面
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // 处理 Cloudflare Turnstile 验证
    const turnstileElement = await page.$('div.cf-turnstile')
    if (turnstileElement) {
        console.log('检测到 Cloudflare Turnstile，正在处理...')
        const turnstileDetails = await turnstileElement.evaluate(el => ({
            sitekey: el.getAttribute('data-sitekey'),
            action: el.getAttribute('data-action'),
            cdata: el.getAttribute('data-cdata'),
        }))
        
        const pageUrl = page.url()
        const token = await solveTurnstile(turnstileDetails.sitekey, pageUrl, turnstileDetails.action, turnstileDetails.cdata)

        console.log('正在将 Turnstile 令牌注入页面...')
        await page.evaluate((tokenValue) => {
            const responseElement = document.querySelector('[name="cf-turnstile-response"]')
            if (responseElement) {
                responseElement.value = tokenValue
            }
            const callbackName = document.querySelector('.cf-turnstile')?.dataset.callback
            if (callbackName && typeof window[callbackName] === 'function') {
                window[callbackName](tokenValue)
            }
        }, token)
        console.log('Turnstile 令牌已注入。')
    } else {
        console.log('未检测到 Cloudflare Turnstile。')
    }

    // 图形验证码处理
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    await page.locator('text=無料VPSの利用を継続する').click()

} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
