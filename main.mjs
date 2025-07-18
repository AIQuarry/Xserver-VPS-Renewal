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
    
    // 新增：处理Cloudflare复选框验证
    await page.waitForSelector('label.cb-lb', { timeout: 10000 });
    
    // 确保复选框可见并启用
    await page.evaluate(() => {
        const label = document.querySelector('label.cb-lb');
        if (label) {
            // 确保标签可见
            label.style.visibility = 'visible';
            label.style.display = 'block';
            label.style.opacity = '1';
            
            // 确保复选框可点击
            const checkbox = label.querySelector('input[type="checkbox"]');
            if (checkbox) {
                checkbox.disabled = false;
                checkbox.style.pointerEvents = 'auto';
            }
        }
    });
    
    // 点击复选框标签
    await page.click('label.cb-lb');
    
    // 验证是否已勾选
    const isChecked = await page.$eval('label.cb-lb input[type="checkbox"]', checkbox => checkbox.checked);
    if (!isChecked) {
        // 如果未勾选，尝试直接点击复选框
        await page.click('label.cb-lb input[type="checkbox"]');
    }
    
    // 等待验证完成
    await setTimeout(2000);
    
    // 继续原有流程
    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
