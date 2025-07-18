import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import TwoCaptcha from '2captcha';

// 初始化 2Captcha 解决器
const solver = new TwoCaptcha.Solver(process.env.TWOCAPTCHA_KEY);

// 配置 Puppeteer 启动参数
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
await page.setUserAgent(userAgent.replace('Headless', '')); // 移除 Headless 标识
const recorder = await page.screencast({ path: 'recording.webm' }); // 录制屏幕

try {
    // 代理身份验证（如果有）
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER);
        if (username && password) {
            await page.authenticate({ username, password });
        }
    }

    // 访问登录页面并等待网络空闲
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' });
    await page.locator('#memberid').fill(process.env.EMAIL);
    await page.locator('#user_password').fill(process.env.PASSWORD);
    await page.locator('text=ログインする').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
    await page.locator('text=更新する').click();
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 获取并提交图像验证码
    const body = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text());
    console.log('获取的验证码：', code);

    // 等待验证码输入框出现
    await page.waitForSelector('[placeholder="上の画像の数字を入力"]', { timeout: 30000 });
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);
    await page.waitForTimeout(35000); // 等待 5 秒以确保页面响应

    // 检查 Cloudflare Turnstile 挑战
    const turnstileIframe = await page.$('#cf-chl-widget-x0421');
    if (turnstileIframe) {
        console.log('检测到 Cloudflare Turnstile 挑战，调用 2Captcha 解决...');

        // 从 iframe src 中提取 sitekey
        const iframeSrc = await turnstileIframe.evaluate(el => el.getAttribute('src'));
        const sitekeyMatch = iframeSrc.match(/0x4[A-Za-z0-9]+/);
        const sitekey = sitekeyMatch ? sitekeyMatch[0] : null;
        if (!sitekey) {
            throw new Error('无法从 iframe src 中提取 sitekey');
        }

        const pageUrl = page.url();

        // 使用 2Captcha 解决 Turnstile 挑战
        const res = await solver.turnstile({
            pageurl: pageUrl,
            sitekey: sitekey,
        });
        const token = res.data;
        console.log('2Captcha 返回的令牌：', token);

        // 注入令牌到隐藏输入字段
        await page.evaluate((token) => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
            } else {
                throw new Error('未找到 cf-turnstile-response 输入字段');
            }
        }, token);

        // 等待 Turnstile 验证完成
        await page.waitForTimeout(5000); // 等待 5 秒
        console.log('Turnstile 挑战已解决并注入令牌');
    } else {
        console.log('未检测到 Turnstile 挑战，继续执行...');
    }

    // 等待目标按钮出现并确保可交互
    await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 20000 }); // 延长到 20 秒
    const button = await page.$('text=無料VPSの利用を継続する');
    if (button) {
        await button.click();
        console.log('成功点击“無料VPSの利用を継続する”');
    } else {
        console.error('未找到“無料VPSの利用を継続する”按钮');
        await page.screenshot({ path: 'error-screenshot.png' }); // 保存错误截图
        throw new Error('目标按钮未找到');
    }

    // 等待导航完成（如果点击触发页面跳转）
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
        console.log('未检测到导航，可能无需跳转');
    });
} catch (e) {
    console.error('发生错误：', e);
    await page.screenshot({ path: 'error-screenshot.png' }); // 保存错误截图
} finally {
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
}
