import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout as delay } from 'node:timers/promises';

// Apply the Stealth plugin to evade anti-bot detection
puppeteer.use(StealthPlugin());

// --- 2Captcha Configuration ---
// Read the API key from environment variables.
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/**
 * Polls the 2Captcha API to get the solved result.
 * @param {string} captchaId - The captcha task ID obtained from /in.php.
 * @returns {Promise<string>} - The solved token or captcha text.
 */
async function pollFor2CaptchaResult(captchaId) {
    console.log(`Task submitted to 2Captcha, ID: ${captchaId}. Waiting for server to process...`);

    // Initial delay to allow the server to receive the task
    await delay(20000);

    while (true) {
        try {
            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`);
            const result = await resultResponse.json();

            if (result.status === 1) {
                console.log(`2Captcha solved successfully! Result: ${result.request.substring(0, 30)}...`);
                return result.request;
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                throw new Error(`An error occurred during 2Captcha solving process: ${result.request}`);
            }

            console.log('2Captcha CAPTCHA not solved yet, retrying in 10 seconds...');
            await delay(10000);
        } catch (error) {
            console.error("Network error while polling 2Captcha results:", error);
            // Wait before retrying in case of network issues
            await delay(10000);
        }
    }
}

/**
 * Solves Cloudflare Turnstile using 2Captcha.
 * @param {string} sitekey - The data-sitekey from the page's HTML.
 * @param {string} pageUrl - The full URL of the page with the Turnstile challenge.
 * @param {string} [action] - The value from the data-action attribute (optional).
 * @param {string} [cdata] - The value from the data-cdata attribute (optional).
 * @returns {Promise<string>} - The solved Turnstile token.
 */
async function solveTurnstile(sitekey, pageUrl, action, cdata) {
    console.log('Requesting Turnstile solve from 2Captcha...');
    const payload = new URLSearchParams({
        key: TWOCAPTCHA_API_KEY,
        method: 'turnstile',
        sitekey: sitekey,
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

    // IMPORTANT: 2Captcha's in.php endpoint expects form data, not JSON.
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
    // Check for necessary environment variables
    if (!TWOCAPTCHA_API_KEY || !process.env.EMAIL || !process.env.PASSWORD) {
        console.error('Error: Please ensure TWOCAPTCHA_API_KEY, EMAIL, and PASSWORD environment variables are set.');
        process.exit(1);
    }

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars', // Hides "Chrome is being controlled by automated test software"
        '--window-size=1280,800',
    ];

    // --- Read and configure proxy from environment variables ---
    if (process.env.PROXY_SERVER) {
        console.log(`Proxy server config detected, using: ${process.env.PROXY_SERVER}`);
        args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
        args,
        headless: 'new', // Use the new headless mode for better compatibility
        ignoreHTTPSErrors: true,
    });

    const page = (await browser.pages())[0];
    await page.setViewport({ width: 1280, height: 800 });

    // --- Authenticate proxy if username and password are provided ---
    if (process.env.PROXY_SERVER && process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
        console.log(`Authenticating for proxy server...`);
        await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
        });
    }

    // --- Set a realistic User-Agent ---
    const originalUserAgent = await browser.userAgent();
    const userAgent = originalUserAgent.replace('HeadlessChrome', 'Chrome');
    console.log('Setting User-Agent to:', userAgent);
    await page.setUserAgent(userAgent);

    const recorder = await page.screencast({ path: 'recording.webm' }); // Enable screen recording

    try {
        console.log('Navigating to login page...');
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Filling in login information...');
        await page.locator('#memberid').fill(process.env.EMAIL);
        await page.locator('#user_password').fill(process.env.PASSWORD);

        console.log('Clicking login button...');
        await page.locator('::-p-text(ログインする)').click();

        console.log('Login successful, waiting for server detail page link to appear...');
        const serverDetailLinkLocator = page.locator('a[href^="/xapanel/xvps/server/detail?id="]');
        await serverDetailLinkLocator.waitFor({ state: 'visible', timeout: 60000 });
        console.log('Clicking server detail link...');
        await serverDetailLinkLocator.click();
        
        console.log('On server detail page. Waiting for the update button to be visible...');
        // FIX: Adopt a step-by-step defensive strategy. Wait, screenshot, then click.
        const updateButtonLocator = page.locator('::-p-xpath(//a[contains(., "更新する") and contains(@class, "button")])');
        await updateButtonLocator.waitFor({ state: 'visible', timeout: 30000 });

        console.log('Update button is visible. Taking screenshot before click for debugging...');
        await page.screenshot({ path: 'debug_before_update_click.png' });

        console.log('Clicking the update button...');
        await updateButtonLocator.click();
        
        console.log('Clicked "Update" button. Waiting for the "Continue" button to appear...');
        const continueButtonLocator = page.locator('::-p-xpath(//a[contains(., "引き続き無料VPSの利用を継続する")])');
        await continueButtonLocator.waitFor({ state: 'visible', timeout: 60000 });
        console.log('Clicking "Continue" button...');
        await continueButtonLocator.click();

        console.log('Clicked "Continue" button. Waiting for the final confirmation page to load...');
        // Wait for an element on the final page, like the captcha input, to ensure the page is ready.
        const captchaInputLocator = page.locator('[placeholder="上の画像の数字を入力"]');
        await captchaInputLocator.waitFor({ state: 'visible', timeout: 60000 });
        console.log('Final confirmation page loaded. Processing CAPTCHA...');

        // --- CAPTCHA Handling Logic ---

        // 1. Handle Cloudflare Turnstile (using 2Captcha)
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

        // 2. Handle image CAPTCHA
        const imageCaptchaElement = await page.$('img[src^="data:image/png;base64,"]');
        if (imageCaptchaElement) {
            console.log('Image CAPTCHA detected, processing with your API...');
            const base64Image = await imageCaptchaElement.evaluate(img => img.src);
            const codeResponse = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { 
                method: 'POST', 
                headers: {'Content-Type': 'text/plain'}, // Assuming your API expects plain text
                body: base64Image 
            });
            if (!codeResponse.ok) {
                throw new Error(`Image CAPTCHA API failed with status: ${codeResponse.status}`);
            }
            const code = await codeResponse.text();
            console.log(`Image CAPTCHA recognition result: ${code}`);
            await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);
            console.log('Image CAPTCHA filled.');
        } else {
            console.log('Image CAPTCHA not found.');
        }

        // 3. Tick the confirmation checkbox
        console.log('Finding and clicking the "confirm I am human" checkbox...');
        const checkboxXpath = '//label[contains(., "人間であることを確認します")]/input[@type="checkbox"]';
        await page.locator(`::-p-xpath(${checkboxXpath})`).click();
        console.log('Checkbox successfully clicked.');

        console.log('Waiting 2 seconds to ensure all validation scripts have run...');
        await delay(2000);

        console.log('All CAPTCHA handling complete, submitting renewal...');
        const finalSubmitLocator = page.locator('button.button.button-primary[type="submit"]');
        
        // The final click might actually trigger a full navigation. We can combine the click
        // and the navigation wait into one promise to avoid race conditions.
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
            finalSubmitLocator.click()
        ]);
        
        const successMessage = await page.evaluate(() => document.body.innerText.includes('手続きが完了しました'));
        if (successMessage) {
            console.log('SUCCESS! VPS renewal completed.');
        } else {
            console.log('Renewal may not have been successful. Please check the final page content.');
        }
        await page.screenshot({ path: 'final_page.png', fullPage: true });

    } catch (e) {
        console.error('An error occurred during script execution:', e);
        // Add a check to see if the page is still open before taking a screenshot
        if (!page.isClosed()) {
            await page.screenshot({ path: 'error.png', fullPage: true });
        }
    } finally {
        await recorder.stop(); // Stop recording and save the file
        console.log('Task finished. Browser will close in 5 seconds...');
        await delay(5000);
        await browser.close();
    }
}

main();
