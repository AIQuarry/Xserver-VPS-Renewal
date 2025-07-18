import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';

// 模拟点击 Cloudflare Turnstile 复选框
async function clickTurnstileCheckbox(page) {
    console.log('正在查找 Turnstile 复选框...');
    const checkboxSelector = '.cb-lb input[type="checkbox"]';
    
    // 等待复选框出现（最多 10 秒）
    const checkbox = await page.waitForSelector(checkboxSelector, { timeout: 10000 }).catch(() => {
        console.warn('未找到 Turnstile 复选框，跳过点击');
        return null;
    });
    if (!checkbox) return false;

    // 模拟人类行为：随机移动鼠标到复选框
    const box = await checkbox.boundingBox();
    if (box) {
        const x = box.x + box.width / 2 + (Math.random() * 10 - 5); // 随机偏移
        const y = box.y + box.height / 2 + (Math.random() * 10 - 5);
        console.log('模拟鼠标移动到复选框...');
        await page.mouse.move(x, y, { steps: 10 });
        await setTimeout(Math.random() * 100 + 100); // 随机延迟 100-200ms
        await page.mouse.click(x, y);
        console.log('复选框已点击');
    } else {
        console.warn('无法获取复选框位置，尝试直接点击');
        await checkbox.click();
    }

    // 等待验证结果（最多 10 秒）
    console.log('等待验证结果...');
    const isSuccess = await page.waitForSelector(
        '#success, #success-i, .success-circle, #success-text',
        { timeout: 10000 }
    ).catch(() => null);

    if (isSuccess) {
        console.log('检测到 Turnstile 验证成功状态');
        return true;
    } else {
        console.warn('未检测到 Turnstile 验证成功状态，可能是页面跳转或验证失败');
        // 检查页面是否跳转
        const currentUrl = page.url();
        await setTimeout(2000); // 等待可能的跳转
        if (currentUrl !== page.url()) {
            console.log('页面已跳转，验证可能成功');
            return true;
        }
        return false;
    }
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
    console.log('访问登录页面...');
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    // 填写登录信息
    console.log('填写登录信息...');
    await page.locator('#memberid').fill(process.env.EMAIL);
    await page.locator('#user_password').fill(process.env.PASSWORD);
    await page.locator('text=ログインする').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    // 导航到 VPS 详情页面
    console.log('导航到 VPS 详情页面...');
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
    await page.locator('text=更新する').click();
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    // 处理图片验证码
    console.log('处理图片验证码...');
    await page.waitForSelector('img[src^="data:"]', { timeout: 10000 });
    const body = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body
    }).then(r => r.text());
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);
    console.log('图片验证码已填写');

    // 模拟点击 Turnstile 复选框
    console.log('开始处理 Cloudflare Turnstile 验证...');
    const turnstileSuccess = await clickTurnstileCheckbox(page);
    if (!turnstileSuccess) {
        console.warn('Turnstile 验证可能失败，尝试继续流程');
    }

    // 提交续订
    console.log('提交续订请求...');
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
