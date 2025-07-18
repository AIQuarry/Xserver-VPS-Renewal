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

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { 
        waitUntil: 'networkidle2',
        timeout: 60000
    })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
    
    // 处理图片验证码
    await page.waitForSelector('img[src^="data:"]', { timeout: 10000 })
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    
    // 新增：使用文本定位处理Cloudflare复选框验证
    // 更可靠的定位方式 - 使用文本内容
    const checkboxSelector = 'text/人間であることを確認します';
    
    try {
        // 等待最多15秒
        await page.waitForSelector(checkboxSelector, { timeout: 15000 });
        
        // 确保元素可见
        await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (element) {
                element.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }, checkboxSelector);
        
        // 点击复选框
        await page.click(checkboxSelector);
        
        // 验证是否已勾选
        const isChecked = await page.$eval('input[type="checkbox"]', checkbox => checkbox.checked);
        if (!isChecked) {
            // 如果未勾选，尝试直接点击复选框
            await page.click('input[type="checkbox"]');
        }
    } catch (e) {
        console.warn('未找到验证复选框，可能已自动验证:', e.message);
    }
    
    // 等待验证完成
    await setTimeout(3000);
    
    // 继续原有流程
    await page.locator('text=無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
