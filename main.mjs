import puppeteer from 'puppeteer';
import { setTimeout as delay } from 'node:timers/promises';

// --- 2Captcha 配置 ---
// 从环境变量读取API密钥。
// 运行前请先设置: export TWOCAPTCHA_API_KEY='YOUR_API_KEY'
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/**
 * 轮询查询 2Captcha API 获取已解决的结果
 * @param {string} captchaId - 从 /in.php 获取的验证码任务ID
 * @returns {Promise<string>} - 解决后的令牌 (token) 或验证码文本
 */
async function pollFor2CaptchaResult(captchaId) {
    console.log(`已将任务提交至 2Captcha, ID: ${captchaId}。正在等待服务器处理...`);
    
    // 给予服务器接收任务的初始等待时间
    await delay(20000); 

    while (true) {
        try {
            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`);
            const result = await resultResponse.json();

            if (result.status === 1) {
                console.log(`2Captcha 解决成功！结果: ${result.request.substring(0, 30)}...`);
                return result.request;
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                throw new Error(`在 2Captcha 解决过程中发生错误: ${result.request}`);
            }

            console.log('2Captcha 验证码尚未解决，10秒后重试...');
            await delay(10000);
        } catch (error) {
            console.error("轮询 2Captcha 结果时发生网络错误:", error);
            await delay(10000);
        }
    }
}

/**
 * 使用 2Captcha 解决 Cloudflare Turnstile
 * @param {string} sitekey - 从页面HTML中获取的 data-sitekey
 * @param {string} pageUrl - 出现 Turnstile 的页面的完整URL
 * @param {string} action - (可选) 从 data-action 属性获取的值
 * @param {string} cdata - (可选) 从 data-cdata 属性获取的值
 * @returns {Promise<string>} - 解决后的 Turnstile 令牌
 */
async function solveTurnstile(sitekey, pageUrl, action, cdata) {
    console.log('正在向 2Captcha 请求解决 Turnstile...');
    const payload = {
        key: TWOCAPTCHA_API_KEY,
        method: 'turnstile',
        sitekey: sitekey,
        pageurl: pageUrl,
        json: 1
    };
    if (action) {
        payload.action = action;
        console.log(`包含 action: ${action}`);
    }
    if (cdata) {
        payload.cdata = cdata;
        console.log(`包含 cdata: ${cdata}`);
    }

    const sendResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const sendResult = await sendResponse.json();
    if (sendResult.status !== 1) {
        throw new Error(`向 2Captcha 发送 Turnstile 请求失败: ${sendResult.request}`);
    }
    return pollFor2CaptchaResult(sendResult.request);
}

/**
 * 主执行函数
 */
async function main() {
    // 检查必要的环境变量
    if (!TWOCAPTCHA_API_KEY || !process.env.EMAIL || !process.env.PASSWORD) {
        console.error('错误: 请确保设置了 TWOCAPTCHA_API_KEY, EMAIL, 和 PASSWORD 环境变量。');
        process.exit(1);
    }

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
    ];

    // --- 从环境变量读取并配置代理 ---
    if (process.env.PROXY_SERVER) {
        console.log(`检测到代理服务器配置，正在使用: ${process.env.PROXY_SERVER}`);
        args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
        defaultViewport: { width: 1080, height: 1024 },
        args,
        headless: 'new' // 在无图形界面的服务器环境中，必须使用无头模式
    });

    const page = (await browser.pages())[0];
    
    // --- 如果提供了用户名和密码，则进行代理身份验证 ---
    if (process.env.PROXY_SERVER && process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
        console.log(`正在为代理服务器进行身份验证...`);
        await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        });
    }

    const userAgent = await browser.userAgent();
    await page.setUserAgent(userAgent.replace('Headless', ''));
    const recorder = await page.screencast({ path: 'recording.webm' }); // 启用屏幕录制

    try {
        console.log('正在访问登录页面...');
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' });
        
        console.log('正在填写登录信息...');
        await page.locator('#memberid').fill(process.env.EMAIL);
        await page.locator('#user_password').fill(process.env.PASSWORD);
        await page.locator('text=ログインする').click();
        
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        console.log('登录成功，正在导航至服务器详情页...');
        await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
        
        await page.waitForSelector('text=更新する');
        await page.locator('text=更新する').click();
        console.log('已点击“更新”按钮');

        await page.waitForSelector('text=引き続き無料VPSの利用を継続する');
        await page.locator('text=引き続き無料VPSの利用を継続する').click();
        console.log('已点击“继续使用免费VPS”');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        console.log('已到达最终确认页面，正在处理验证码...');

        // --- 验证码处理逻辑 ---

        // 1. 处理 Cloudflare Turnstile (使用 2Captcha)
        const turnstileElement = await page.$('div.cf-turnstile');
        if (turnstileElement) {
            console.log('检测到 Cloudflare Turnstile，正在处理...');
            const turnstileDetails = await turnstileElement.evaluate(el => ({
                sitekey: el.getAttribute('data-sitekey'),
                action: el.getAttribute('data-action'),
                cdata: el.getAttribute('data-cdata'),
            }));
            
            const pageUrl = page.url();
            const token = await solveTurnstile(turnstileDetails.sitekey, pageUrl, turnstileDetails.action, turnstileDetails.cdata);
            
            console.log('正在将 Turnstile 令牌注入页面...');
            await page.evaluate((tokenValue) => {
                const responseElement = document.querySelector('[name="cf-turnstile-response"]');
                if (responseElement) {
                    responseElement.value = tokenValue;
                }
                const callbackName = document.querySelector('.cf-turnstile')?.dataset.callback;
                if (callbackName && typeof window[callbackName] === 'function') {
                    window[callbackName](tokenValue);
                }
            }, token);
            console.log('Turnstile 令牌已注入。');
        } else {
            console.log('未检测到 Cloudflare Turnstile。');
        }

        // 2. 接着处理图形验证码 (使用您指定的API)
        const imageCaptchaElement = await page.$('img[src^="data:"]');
        if (imageCaptchaElement) {
            console.log('检测到图形验证码，正在使用您的API处理...');
            const body = await imageCaptchaElement.evaluate(img => img.src);
            const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text());
            console.log(`图形验证码识别结果: ${code}`);
            await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);
            console.log('图形验证码已填写。');
        } else {
            console.log('未找到图形验证码。');
        }


        console.log('所有验证码处理完毕，正在提交续订...');
        await page.locator('text=無料VPSの利用を継続する').click();
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        const successMessage = await page.evaluate(() => document.body.textContent.includes('手続きが完了しました'));
        if (successMessage) {
            console.log('成功！VPS 续期完成。');
        } else {
            console.log('续期可能未成功，请检查最终页面内容。');
        }
        await page.screenshot({ path: 'final_page.png' });

    } catch (e) {
        console.error('脚本执行过程中发生错误:', e);
        await page.screenshot({ path: 'error.png' });
    } finally {
        await recorder.stop(); // 停止录制并保存文件
        console.log('任务完成，5秒后将关闭浏览器...');
        await delay(5000);
        await browser.close();
    }
}

main();
