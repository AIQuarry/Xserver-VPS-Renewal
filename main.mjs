import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
const proxy = process.env.PROXY_SERVER

if (proxy) {
    const proxyUrl = new URL(proxy)
    proxyUrl.username = ''
    proxyUrl.password = ''
    args.push(`--proxy-server=${proxyUrl.origin}`)
}

const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1080, height: 1024 },
    args,
})

const [page] = await browser.pages()

// 防止检测 Puppeteer
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
})

// 录屏（可选）
let recorder
if (page.screencast) {
    recorder = await page.screencast({ path: 'recording.webm' }).catch(() => null)
}

try {
    if (proxy) {
        const { username, password } = new URL(proxy)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    // 打开登录页
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })

    // 登录表单
    await page.type('#memberid', process.env.EMAIL || '', { delay: 50 })
    await page.type('#user_password', process.env.PASSWORD || '', { delay: 50 })
    await Promise.all([
        page.click('button[type="submit"], text=ログインする'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ])

    // 进入 VPS 详情页
    await page.click('a[href^="/xapanel/xvps/server/detail?id="]')
    await page.waitForSelector('text=更新する')
    await page.click('text=更新する')

    // 续费确认
    await page.waitForSelector('text=引き続き無料VPSの利用を継続する')
    await page.click('text=引き続き無料VPSの利用を継続する')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // 获取验证码图像
    const imgSrc = await page.$eval('img[src^="data:"]', img => img.src)
    const res = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body: imgSrc,
    })
    const code = await res.text()

    // 输入验证码
    await page.type('[placeholder="上の画像の数字を入力"]', code, { delay: 50 })

    // 最终确认
    await page.click('text=無料VPSの利用を継続する')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    console.log('VPS 续期成功')
} catch (err) {
    console.error('脚本异常：', err)
} finally {
    await setTimeout(5000)
    if (recorder?.stop) await recorder.stop()
    await browser.close()
}
