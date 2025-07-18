import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';

// Cloudflare Turnstile 验证函数
async function solveTurnstile(page) {
    const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY;
    if (!TWO_CAPTCHA_API_KEY) throw new Error('缺少 2CAPTCHA_API_KEY 环境变量');

    // 综合 iframe 选择器，适配多种语言和配置
    const iframeSelector = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[title*="Cloudflare"]',
        'iframe[data-sitekey]',
        'iframe[title*="チャレンジ"]',
        'iframe[title*="验证"]'
    ].join(',');

    // 等待 Turnstile iframe 出现（最多 10 秒）
    const iframe = await page.waitForSelector(iframeSelector, { timeout: 10000 }).catch(() => {
        console.warn('未找到 Cloudflare Turnstile iframe，跳过验证');
        return null;
    });
    if (!iframe) return;

    // 点击复选框触发验证
    const checkbox = await page.$('.cb-lb input[type="checkbox"]');
    if (checkbox) {
        await checkbox.click();
        await setTimeout(1000); // 等待控件加载
    }

    // 提取 sitekey
    const sitekey = await page.evaluate(() => {
        const iframe = Array.from(document.querySelectorAll('iframe')).find(
            f => f.src.includes('challenges.cloudflare.com') || f.title.includes('Cloudflare')
        );
        if (iframe) return iframe.getAttribute('data-sitekey') || iframe.dataset.sitekey;
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            if (script.textContent.includes('sitekey')) {
                const match = script.textContent.match(/sitekey\s*:\s*["']([^"']+)["']/);
                if (match) return match[1];
            }
        }
        return null;
    });

    if (!sitekey) throw new Error('无法从页面提取 sitekey');

    // 提交到 2Captcha
    const formData = new URLSearchParams();
    formData.append('key', TWO_CAPTCHA_API_KEY);
    formData.append('method', 'turnstile');
    formData.append('sitekey', sitekey);
    formData.append('pageurl', page.url());
    formData.append('json', '1');

    const submitResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        body: formData
    }).catch(err => {
        throw new Error(`2Captcha API 请求失败: ${err.message}`);
    });
    const submitData = await submitResponse.json();

    if (submitData.status !== 1) throw new Error(`2Captcha 提交失败: ${submitData.request}`);
    const captchaId = submitData.request;

    // 轮询获取结果（最长 3 分钟）
    const maxAttempts = parseInt(process.env.TURNSTILE_MAX_ATTEMPTS || '36', 10);
    for (let i = 0; i < maxAttempts; i++) {
        await setTimeout(5000);
        const resultResponse = await fetch(
            `https://2captcha.com/res.php?key=${TWO_CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`
        ).catch(err => {
            throw new Error(`2Captcha 轮询失败: ${err.message}`);
        });
        const resultData = await resultResponse.json();

        if (resultData.status === 1) {
            const token = resultData.request;
            // 注入 token
            const tokenSet = await page.evaluate((token) => {
                const textarea = document.querySelector('textarea[name="cf-turnstile-response"]') ||
                                 document.querySelector('input[name="cf-turnstile-response"]');
                if (textarea) {
                    textarea.value = token;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    return textarea.value === token;
                }
                const iframes = document.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        const iframeTextarea = iframeDoc.querySelector('textarea[name="cf-turnstile-response"]');
                        if (iframeTextarea) {
                            iframeTextarea.value = token;
                            iframeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                            return iframeTextarea.value === token;
                        }
                    } catch (e) {
                        // 跨域 iframe，跳过
                    }
                }
                return false;
            }, token);

            if (!tokenSet) {
                console.warn('无法设置 Turnstile token');
            } else {
                // 等待验证完成
                await setTimeout(2000);
                const isSuccess = await page.waitForSelector('#success', { timeout: 5000 }).catch(() => null);
                if (!isSuccess) {
                    console.warn('Turnstile 验证未成功完成');
                }
            }
            return token;
        }
        if (resultData.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha 错误: ${resultData.request}`);
    }
    throw new Error('2Captcha 超时');
}

// 主脚本
const args = ['--no-sandbox', '--disable-setuid-sandbox'];
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER);
    proxy_url.username = '';
    proxy_url.password = '';
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''));
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
});
const [page] = await browser.pages();
const userAgent = await browser.userAgent();
await page.setUserAgent(userAgent.replace('Headless', ''));
const recorder = await page.screencast({ path: 'recording.webm' });

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER);
        if (username && password) {
            await page.authenticate({ username, password });
        } else {
            console.warn('提供代理 URL 但未找到凭据');
        }
    }

    // 访问登录页面
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    // 填写登录信息
    await page.locator('#memberid').fill(process.env.EMAIL);
    await page.locator('#user_password').fill(process.env.PASSWORD);
    await page.locator('text=ログインする').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    // 导航到 VPS 详情页面
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
    await page.locator('text=更新する').click();
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    // 处理图片验证码
    await page.waitForSelector('img[src^="data:"]', { timeout: 10000 });
    const body = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body
    }).then(r => r.text());
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);

    // 处理 Cloudflare Turnstile 验证
    await solveTurnstile(page);

    // 提交续订
    await page.locator('text=無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    console.log('VPS 续订流程完成');
} catch (e) {
    console.error('错误:', e);
} finally {
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
}
