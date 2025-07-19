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

    // 增强验证检测逻辑 - 检测多种可能的验证元素
    let cfDetected = false;
    
    // 方法1: 检测Cloudflare iframe
    try {
        await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', {
            visible: true,
            timeout: 5000
        });
        cfDetected = true;
        console.log('检测到Cloudflare iframe验证');
    } catch (e) {
        console.log('未检测到Cloudflare iframe验证');
    }
    
    // 方法2: 检测"人間であることを確認します"文本
    if (!cfDetected) {
        try {
            await page.waitForSelector('text=人間であることを確認します', {
                visible: true,
                timeout: 5000
            });
            cfDetected = true;
            console.log('检测到"人間であることを確認します"文本验证');
        } catch (e) {
            console.log('未检测到"人間であることを確認します"文本验证');
        }
    }
    
    // 方法3: 检测Cloudflare品牌元素
    if (!cfDetected) {
        try {
            await page.waitForSelector('div#branding, a.cf-link', {
                visible: true,
                timeout: 5000
            });
            cfDetected = true;
            console.log('检测到Cloudflare品牌元素');
        } catch (e) {
            console.log('未检测到Cloudflare品牌元素');
        }
    }

    if (cfDetected) {
        console.log('检测到Cloudflare验证，开始处理...');
        
        // 尝试提取sitekey
        let sitekey = null;
        try {
            const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]');
            if (iframe) {
                sitekey = await iframe.evaluate(frame => {
                    const src = frame.src;
                    const match = src.match(/\/av0\/([^\/]+)\//);
                    return match ? match[1] : null;
                });
            }
        } catch (e) {
            console.log('提取sitekey失败:', e.message);
        }
        
        if (!sitekey) {
            // 尝试从页面中提取sitekey
            try {
                const sitekeyScript = await page.$eval('script', scripts => {
                    for (const script of Array.from(scripts)) {
                        if (script.textContent.includes('turnstile')) {
                            const match = script.textContent.match(/sitekey: ['"]([^'"]+)['"]/);
                            return match ? match[1] : null;
                        }
                    }
                    return null;
                });
                
                if (sitekeyScript) {
                    sitekey = sitekeyScript;
                    console.log('从脚本中提取到sitekey:', sitekey);
                }
            } catch (e) {
                console.log('从脚本提取sitekey失败:', e.message);
            }
        }
        
        if (!sitekey) {
            // 使用默认sitekey作为备选方案
            sitekey = '0x4AAAAAABlb1fIlWBrSDU3B';
            console.log('使用默认sitekey:', sitekey);
        } else {
            console.log('使用提取的sitekey:', sitekey);
        }
        
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
            // 尝试多种注入方式
            const injectToken = () => {
                // 方式1: 通过iframe注入
                const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                if (iframe && iframe.contentWindow) {
                    iframe.contentWindow.postMessage({
                        event: 'challenge-complete',
                        data: { token }
                    }, '*');
                    return true;
                }
                
                // 方式2: 通过全局对象注入
                if (window.turnstile) {
                    window.turnstile.render = function(element, options) {
                        return {
                            reset: () => {},
                            getResponse: () => token
                        };
                    };
                    return true;
                }
                
                // 方式3: 设置隐藏字段
                const responseInput = document.querySelector('input[name="cf-turnstile-response"]');
                if (responseInput) {
                    responseInput.value = token;
                    return true;
                }
                
                return false;
            };
            
            if (!injectToken()) {
                console.error('无法注入验证token');
            }
        }, token);
        
        // 等待验证完成
        console.log('等待验证完成...');
        try {
            // 等待成功标志或复选框消失
            await Promise.race([
                page.waitForSelector('#success', { visible: true, timeout: 30000 }),
                page.waitForSelector('text=人間であることを確認します', { hidden: true, timeout: 30000 })
            ]);
        } catch (e) {
            console.log('验证完成状态检测超时，继续执行');
        }
        await setTimeout(2000); // 额外等待确保完成
    } else {
        console.log('未检测到Cloudflare验证');
    }

    // 点击最终按钮（无论是否有验证）
    console.log('点击最终按钮...');
    await page.locator('text=無料VPSの利用を継続する').click();
    
    // 等待确认页面加载
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('VPS续期操作成功完成');
    
} catch (e) {
    console.error('发生错误:', e);
    // 截图以便调试
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: `error-${timestamp}.png` });
    console.log('已保存错误截图');
} finally {
    await setTimeout(3000);
    await recorder.stop();
    await browser.close();
    console.log('浏览器已关闭');
}
