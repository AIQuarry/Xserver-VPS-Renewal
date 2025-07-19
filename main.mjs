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
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

    // 检查Cloudflare验证是否存在
    let cfFrame;
    try {
        // 等待最多5秒检查验证框是否出现
        cfFrame = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { 
            visible: true, 
            timeout: 5000 
        });
    } catch (e) {
        console.log('未检测到Cloudflare验证');
    }

    if (cfFrame) {
        console.log('检测到Cloudflare验证，开始处理...');
        
        // 提取sitekey
        const sitekey = await cfFrame.evaluate(frame => {
            const src = frame.src;
            const match = src.match(/\/av0\/([^\/]+)\//);
            return match ? match[1] : null;
        });
        
        if (!sitekey) throw new Error('无法从iframe提取sitekey');
        console.log(`检测到Cloudflare验证, sitekey: ${sitekey}`);
        
        // 使用2Captcha解决验证
        console.log('使用2Captcha解决验证...');
        const pageUrl = page.url();
        const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_KEY;
        if (!TWOCAPTCHA_KEY) throw new Error('未设置TWOCAPTCHA_KEY环境变量');
        
        // 提交验证请求
        const submitUrl = `https://2captcha.com/in.php?key=${TWOCAPTCHA_KEY}&method=turnstile&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}`;
        const submitRes = await fetch(submitUrl);
        const submitText = await submitRes.text();
        
        if (!submitText.startsWith('OK|')) throw new Error(`2Captcha提交错误: ${submitText}`);
        const captchaId = submitText.split('|')[1];
        console.log(`验证任务已提交, ID: ${captchaId}`);
        
        // 获取验证结果
        let token = null;
        for (let i = 0; i < 20; i++) {
            await setTimeout(5000); // 每5秒检查一次
            const resultUrl = `https://2captcha.com/res.php?key=${TWOCAPTCHA_KEY}&action=get&id=${captchaId}`;
            const resultRes = await fetch(resultUrl);
            const resultText = await resultRes.text();
            
            if (resultText === 'CAPCHA_NOT_READY') {
                console.log(`验证处理中... (${i+1}/20)`);
                continue;
            }
            
            if (resultText.startsWith('OK|')) {
                token = resultText.split('|')[1];
                console.log('成功获取验证token');
                break;
            }
            
            throw new Error(`2Captcha错误: ${resultText}`);
        }
        
        if (!token) throw new Error('获取验证token超时');
        
        // 注入token到页面
        console.log('注入验证token...');
        await page.evaluate((token) => {
            document.querySelector('iframe[src*="challenges.cloudflare.com"]').contentWindow.postMessage({
                event: 'challenge-complete',
                data: { token }
            }, '*');
        }, token);
        
        // 等待验证完成
        console.log('等待验证完成...');
        await page.waitForSelector('#success', { visible: true, timeout: 30000 });
        await setTimeout(2000); // 额外等待确保完成
    } else {
        console.log('跳过Cloudflare验证处理');
    }

    // 点击最终按钮（无论是否有验证）
    console.log('点击最终按钮...');
    await page.locator('text=無料VPSの利用を継続する').click();
    
} catch (e) {
    console.error('发生错误:', e);
    // 截图以便调试
    await page.screenshot({ path: 'error.png' });
} finally {
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
}
