import puppeteer from 'puppeteer';
import { setTimeout as delay } from 'node:timers/promises';

// --- 2Captcha 配置 ---
// 从环境变量读取API密钥。
// 运行前请先设置: export TWOCAPTCHA_API_KEY='YOUR_API_KEY'
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/**
 * 轮询查询 2Captcha API 获取已解决的结果
 * @param {string} captchaId - 从 /in.php 获取的验证码任务ID
 * @returns {Promise<string>} - 解决后的令牌 (token)
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
                // 成功
                console.log(`解决成功！令牌: ${result.request.substring(0, 30)}...`);
                return result.request;
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                // 如果返回的不是“尚未准备好”，则说明是其他错误
                throw new Error(`在 2Captcha 解决过程中发生错误: ${result.request}`);
            }

            // 验证码尚未解决
            console.log('验证码尚未解决，10秒后重试...');
            await delay(10000); // 每10秒查询一次
        } catch (error) {
            console.error("轮询 2Captcha 结果时发生网络错误:", error);
            // 发生错误时也等待后重试
            await delay(10000);
        }
    }
}

/**
 * 使用 2Captcha 解决 Cloudflare Turnstile
 * @param {string} sitekey - 从页面HTML中获取的 data-sitekey
 * @param {string} pageUrl - 出现 Turnstile 的页面的完整URL
 * @returns {Promise<string>} - 解决后的 Turnstile 令牌
 */
async function solveTurnstile(sitekey, pageUrl) {
    console.log('正在向 2Captcha 请求解决 Turnstile...');
    const sendResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            key: TWOCAPTCHA_API_KEY,
            method: 'turnstile',
            sitekey: sitekey,
            pageurl: pageUrl,
            json: 1 // 以JSON格式接收响应
        })
    });
    const sendResult = await sendResponse.json();
    if (sendResult.status !== 1) {
        throw new Error(`向 2Captcha 发送请求失败: ${sendResult.request}`);
    }

    // 调用轮询函数等待结果
    return pollFor2CaptchaResult(sendResult.request);
}

/**
 * 主执行函数
 */
async function main() {
    // 检查API密钥是否存在
    if (!TWOCAPTCHA_API_KEY) {
        console.error('错误: 环境变量 TWOCAPTCHA_API_KEY 未设置。');
        process.exit(1);
    }

    // 从命令行参数获取URL
    const targetUrl = process.argv[2];
    if (!targetUrl) {
        console.error('错误: 请提供需要解决的目标URL作为命令行参数。');
        console.log('用法: node solve_turnstile.js "https://example.com/login"');
        process.exit(1);
    }

    console.log(`正在启动浏览器...`);
    // 设置 headless: false 可以在运行时显示浏览器窗口
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    try {
        console.log(`正在导航至: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        console.log('正在查找 Cloudflare Turnstile 元素...');
        // 等待 Turnstile 的 div 元素出现，最长等待30秒
        const turnstileElement = await page.waitForSelector('div.cf-turnstile', { timeout: 30000 });

        if (!turnstileElement) {
            throw new Error('在此页面上未找到 Cloudflare Turnstile。');
        }
        
        console.log('已找到 Turnstile，正在获取 sitekey...');
        const sitekey = await turnstileElement.evaluate(el => el.getAttribute('data-sitekey'));
        if (!sitekey) {
            throw new Error('获取 data-sitekey 属性失败。');
        }
        console.log(`Sitekey: ${sitekey}`);

        // 使用 2Captcha 解决 Turnstile
        const token = await solveTurnstile(sitekey, targetUrl);

        console.log('正在将获取到的令牌注入页面...');
        // 在页面浏览器环境内执行脚本
        await page.evaluate((tokenValue) => {
            // 找到 Turnstile 用于存放响应的隐藏输入框
            const responseElement = document.querySelector('[name="cf-turnstile-response"]');
            if (responseElement) {
                responseElement.value = tokenValue;
            }

            // 执行 data-callback 指定的回调函数
            const callbackName = document.querySelector('.cf-turnstile')?.dataset.callback;
            if (callbackName && typeof window[callbackName] === 'function') {
                console.log(`正在执行回调函数 '${callbackName}'...`);
                window[callbackName](tokenValue);
            }
        }, token);

        console.log('Turnstile 解决和令牌注入完成。');
        
        // --- 新增：自动点击提交按钮 ---
        try {
            console.log('正在尝试点击提交按钮...');
            // 尝试点击常见的提交按钮，例如 <button type="submit">
            const submitButton = await page.waitForSelector('button[type="submit"]', { timeout: 5000 });
            await submitButton.click();
            console.log('提交按钮已点击，等待页面导航...');
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        } catch (error) {
            console.log('未找到提交按钮或点击后没有发生页面导航，脚本将继续。');
        }
        
        console.log('后续操作已完成。');

        await page.screenshot({ path: 'turnstile_solved_final.png' });
        console.log('已将最终页面的截图保存为 `turnstile_solved_final.png`。');

    } catch (e) {
        console.error('脚本执行过程中发生错误:', e);
        await page.screenshot({ path: 'error.png' });
        console.log('已将发生错误时的页面截图保存为 `error.png`。');
    } finally {
        console.log('5秒后将关闭浏览器...');
        await delay(5000);
        await browser.close();
    }
}

// 执行脚本
main();
