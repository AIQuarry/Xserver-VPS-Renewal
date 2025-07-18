import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

// 改进的Cloudflare Turnstile验证解决函数
async function solveTurnstile(page) {
    const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
    if (!TWO_CAPTCHA_API_KEY) throw new Error('缺少2CAPTCHA_API_KEY环境变量');
    
    // 更可靠的选择器 - 尝试多种可能的选择器
    const iframeSelector = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[title*="Cloudflare"]',
        'iframe[data-sitekey]',
        'iframe[title*="チャレンジ"]',
        'iframe[title*="验证"]'
    ].join(',');

    // 等待验证框架出现（最多等待10秒）
    try {
        await page.waitForSelector(iframeSelector, { timeout: 10000 });
    } catch (e) {
        // 如果找不到iframe，可能是验证码未加载或不需要验证
        console.warn('未找到Cloudflare验证框架，跳过验证处理');
        return;
    }

    // 提取验证信息
    const sitekey = await page.$eval(
        iframeSelector, 
        iframe => iframe.getAttribute('data-sitekey') || iframe.dataset.sitekey
    );
    
    if (!sitekey) {
        throw new Error('无法从iframe中提取sitekey');
    }
    
    const pageUrl = page.url();

    // 发送请求到2Captcha
    const formData = new URLSearchParams();
    formData.append('key', TWO_CAPTCHA_API_KEY);
    formData.append('method', 'turnstile');
    formData.append('sitekey', sitekey);
    formData.append('pageurl', pageUrl);
    formData.append('json', '1');

    const submitResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        body: formData
    });
    const submitData = await submitResponse.json();

    if (submitData.status !== 1) throw new Error('2Captcha提交失败: ' + submitData.request);
    const captchaId = submitData.request;

    // 轮询获取结果（最长等待2分钟）
    for (let i = 0; i < 24; i++) {
        await setTimeout(5000);
        const resultResponse = await fetch(
            `https://2captcha.com/res.php?key=${TWO_CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`
        );
        const resultData = await resultResponse.json();

        if (resultData.status === 1) return resultData.request; // 返回token
        if (resultData.request !== 'CAPCHA_NOT_READY') throw new Error('2Captcha错误: ' + resultData.request);
    }
    throw new Error('2Captcha超时');
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
    
    // 新增Cloudflare Turnstile验证处理
    const token = await solveTurnstile(page);
    
    if (token) {
        await page.evaluate((token) => {
            // 尝试在父页面设置
            const textarea = document.querySelector('textarea[name="cf-turnstile-response"]');
            if (textarea) {
                textarea.value = token;
                return;
            }
            
            // 如果在框架内
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const iframeTextarea = iframeDoc.querySelector('textarea[name="cf-turnstile-response"]');
                    if (iframeTextarea) {
                        iframeTextarea.value = token;
                        return;
                    }
                } catch (e) {
                    // 跨域iframe无法访问，跳过
                }
            }
            
            // 作为最后手段，尝试通过事件设置
            const event = new Event('input', { bubbles: true });
            const hiddenInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (hiddenInput) {
                hiddenInput.value = token;
                hiddenInput.dispatchEvent(event);
            }
        }, token);
        
        // 等待验证状态更新
        await setTimeout(2000);
    }
    
    // 继续原有流程
    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
