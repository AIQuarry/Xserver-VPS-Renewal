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
await page.setUserAgent(userAgent.replace('Headless', '')); // 移除 Headless 标识以模拟真实浏览器
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
    // 填写用户名和密码
    await page.locator('#memberid').fill(process.env.EMAIL);
    await page.locator('#user_password').fill(process.env.PASSWORD);
    // 点击“登录”按钮
    await page.locator('text=ログインする').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    // 点击 VPS 详情链接
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
    // 点击“更新”按钮
    await page.locator('text=更新する').click();
    // 点击“继续使用免费 VPS”按钮
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    // 获取图像验证码的 base64 数据
    const body = await page.$eval('img[src^="data:"]', img => img.src);
    // 通过外部服务解析图像验证码
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text());
    // 填写图像验证码
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);

    // 检查 Cloudflare Turnstile 挑战
    const turnstileIframe = await page.$('#cf-chl-widget-x0421'); // 使用 iframe 的 ID
    if (turnstileIframe) {
        console.log('检测到 Cloudflare Turnstile 挑战，调用 2Captcha 解决...');

        // 从 iframe 的 src 中提取 sitekey
        const iframeSrc = await turnstileIframe.evaluate(el => el.getAttribute('src'));
        const sitekeyMatch = iframeSrc.match(/0x4[A-Za-z0-9]+/); // 从 src 中提取 sitekey
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

        // 注入令牌到隐藏输入字段
        await page.evaluate((token) => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
            } else {
                throw new Error('未找到 cf-turnstile-response 输入字段');
            }
        }, token);

        console.log('Turnstile 挑战已解决并注入令牌');
    } else {
        console.log('未检测到 Turnstile 挑战，继续执行...');
    }

    // 执行最后一步：点击“继续使用免费 VPS”按钮
    await page.locator('text=無料VPSの利用を継続する').click();
    console.log('成功点击“無料VPSの利用を継続する”');
} catch (e) {
    console.error('发生错误：', e);
} finally {
    // 等待 5 秒后停止录制并关闭浏览器
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
}
