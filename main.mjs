import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout as delay } from 'node:timers/promises';

// Apply the Stealth plugin to evade anti-bot detection
puppeteer.use(StealthPlugin());

// --- 2Captcha Configuration ---
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/**
 * Polls the 2Captcha API to get the solved result.
 * @param {string} captchaId - The captcha task ID obtained from /in.php.
 * @returns {Promise<string>} - The solved token or captcha text.
 */
async function pollFor2CaptchaResult(captchaId) {
    console.log(`Task submitted to 2Captcha, ID: ${captchaId}. Waiting for server to process...`);

    await delay(20000); // Initial delay to allow server to process

    while (true) {
        try {
            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`);
            const result = await resultResponse.json();

            if (result.status === 1) {
                console.log(`2Captcha solved successfully! Result: ${result.request.substring(0, 30)}...`);
                return result.request;
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                throw new Error(`Error during 2Captcha solving: ${result.request}`);
            }

            console.log('2Captcha CAPTCHA not solved yet, retrying in 10 seconds...');
            await delay(10000);
        } catch (error) {
            console.error("Network error while polling 2Captcha results:", error);
            await delay(10000); // Retry after delay if network issues occur
        }
    }
}

async function solveTurnstile(sitekey, pageUrl, action, cdata) {
    console.log('Requesting Turnstile solve from 2Captcha...');
    const payload = new URLSearchParams({
        key: TWOCAPTCHA_API_KEY,
        method: 'turnstile',
        sitekey,
        pageurl: pageUrl,
        json: 1
    });

    if (action) {
        payload.append('action', action);
        console.log(`Including action: ${action}`);
    }
    if (cdata) {
        payload.append('cdata', cdata);
        console.log(`Including cdata: ${cdata}`);
    }

    const sendResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    const sendResult = await sendResponse.json();
    if (sendResult.status !== 1) {
        throw new Error(`Failed to send Turnstile request to 2Captcha: ${sendResult.request}`);
    }
    return pollFor2CaptchaResult(sendResult.request);
}

/**
 * Main execution function.
 */
async function main() {
    if (!TWOCAPTCHA_API_KEY || !process.env.EMAIL || !process.env.PASSWORD) {
        console.error('Error: Please ensure TWOCAPTCHA_API_KEY, EMAIL, and PASSWORD environment variables are set.');
        process.exit(1);
    }

    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars', '--window-size=1280,800'];

    if (process.env.PROXY_SERVER) {
        console.log(`Using proxy server: ${process.env.PROXY_SERVER}`);
        args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
        args,
        headless: 'new', // Use the new headless mode for better compatibility
        ignoreHTTPSErrors: true,
    });

    const page = (await browser.pages())[0];
    await page.setViewport({ width: 1280, height: 800 });

    if (process.env.PROXY_SERVER && process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
        console.log(`Authenticating for proxy server...`);
        await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        });
    }

    const originalUserAgent = await browser.userAgent();
    const userAgent = originalUserAgent.replace('HeadlessChrome', 'Chrome');
    console.log('Setting User-Agent to:', userAgent);
    await page.setUserAgent(userAgent);

    const recorder = await page.screencast({ path: 'recording.webm' }); // Enable screen recording

    try {
        console.log('Navigating to login page...');
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Filling in login information...');
        await page.waitForSelector('#memberid', { visible: true });
        await page.type('#memberid', process.env.EMAIL);

        await page.waitForSelector('#user_password', { visible: true });
        await page.type('#user_password', process.env.PASSWORD);

        console.log('Clicking login button...');
        await page.locator('text=ログインする').click();

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
        console.log('Login successful, navigating to server detail page...');
        
        const serverDetailLinkSelector = 'a[href^="/xapanel/xvps/server/detail?id="]';
        await page.waitForSelector(serverDetailLinkSelector, { visible: true });
        await page.click(serverDetailLinkSelector);
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
        console.log('On server detail page.');

        const updateButtonSelector = 'a.button.button-primary';
        await page.waitForSelector(updateButtonSelector, { visible: true });
        await page.click(updateButtonSelector);
        console.log('Clicked "Update" button');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
        
        const continueFreeButtonSelector = 'a.button.button-primary[href*="contract_update_free_confirm"]';
        await page.waitForSelector(continueFreeButtonSelector, { visible: true });
        await page.click(continueFreeButtonSelector);
        console.log('Clicked "Continue using free VPS"');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
        console.log('Arrived at final confirmation page, processing CAPTCHA...');

        // Handle Cloudflare Turnstile (using 2Captcha)
        const turnstileElement = await page.$('div.cf-turnstile');
        if (turnstileElement) {
            console.log('Cloudflare Turnstile detected, processing...');
            const turnstileDetails = await turnstileElement.evaluate(el => ({
                sitekey: el.getAttribute('data-sitekey'),
                action: el.getAttribute('data-action'),
                cdata: el.getAttribute('data-cdata'),
            }));
            
            const pageUrl = page.url();
            const token = await solveTurnstile(turnstileDetails.sitekey, pageUrl, turnstileDetails.action, turnstileDetails.cdata);
            
            console.log('Injecting Turnstile token into page...');
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
            console.log('Turnstile token injected.');
        } else {
            console.log('Cloudflare Turnstile not detected.');
        }

        // Handle Image CAPTCHA (if present)
        const imageCaptchaElement = await page.$('img[src^="data:image/png;base64,"]');
        if (imageCaptchaElement) {
            console.log('Image CAPTCHA detected, processing with your API...');
            const base64Image = await imageCaptchaElement.evaluate(img => img.src);
            const codeResponse = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { 
                method: 'POST', 
                headers: {'Content-Type': 'text/plain'},
                body: base64Image 
            });
            if (!codeResponse.ok) {
                throw new Error(`Image CAPTCHA API failed with status: ${codeResponse.status}`);
            }
            const code = await codeResponse.text();
            console.log(`Image CAPTCHA recognition result: ${code}`);
            await page.type('[placeholder="上の画像の数字を入力"]', code);
            console.log('Image CAPTCHA filled.');
        } else {
            console.log('Image CAPTCHA not found.');
        }

        console.log('All CAPTCHA handling complete, submitting renewal...');
        const finalSubmitButtonSelector = 'button.button.button-primary[type="submit"]';
        await page.waitForSelector(finalSubmitButtonSelector, { visible: true });
        await page.click(finalSubmitButtonSelector);
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

        const successMessage = await page.evaluate(() => document.body.innerText.includes('手続きが完了しました'));
        if (successMessage) {
            console.log('SUCCESS! VPS renewal completed.');
        } else {
            console.log('Renewal may not have been successful. Please check the final page content.');
        }
        await page.screenshot({ path: 'final_page.png', fullPage: true });

    } catch (e) {
        console.error('An error occurred during script execution:', e);
        await page.screenshot({ path: 'error.png', fullPage: true });
    } finally {
        await recorder.stop(); // Stop recording and save the file
        console.log('Task finished. Browser will close in 5 seconds...');
        await delay(5000);
        await browser.close();
    }
}

main();
