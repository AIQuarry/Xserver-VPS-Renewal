import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
// fs 模块不再需要，已移除
import FormData from 'form-data'
import { Buffer } from 'buffer'

const MAX_RETRIES = 2

/**
 * 上传函数（仅限 Base64）
 * @param {string} base64String - 图片的 Base64 编码字符串
 * @returns {Promise<string|null>} 成功则返回图片 URL，否则返回 null
 */
async function uploadToChevereto(base64String) {
    if (!base64String) {
        console.error('❌ 上传失败：传入的 Base64 数据为空。');
        return null;
    }

    const form = new FormData()
    form.append('format', 'json')

    console.log('🚀 准备上传 Base64 数据...')

    const buffer = Buffer.from(base64String, 'base64');
    // 附加 Buffer 时，必须提供一个文件名，以便API识别文件类型
    form.append('source', buffer, { filename: 'screenshot.png' });

    try {
        const response = await fetch('https://img.piacg.eu.org/api/1/upload', {
            method: 'POST',
            body: form,
            headers: {
                'X-API-Key': process.env.CHEVERETO_API_KEY,
                ...form.getHeaders()
            }
        })

        const result = await response.json()
        if (result.status_code === 200) {
            console.log('✅ 上传成功:', result.image.url)
            return result.image.url
        } else {
            console.error('❌ 上传失败:', result)
            return null
        }
    } catch (error) {
        console.error('❌ 上传过程中发生网络错误:', error)
        return null
    }
}

/**
 * 发送 Server酱 通知
 * @param {string} title - 通知标题
 * @param {string} message - 通知内容 (支持 Markdown)
 */
async function sendServerNotify(title, message) {
    if (!process.env.SCKEY_SENDKEY) {
        console.log('🟡 未配置 SCKEY_SENDKEY，跳过发送通知。');
        return;
    }
    await fetch(`https://sctapi.ftqq.com/${process.env.SCKEY_SENDKEY}.send`, {
        method: 'POST',
        body: new URLSearchParams({
            title,
            desp: message,
        })
    })
}

/**
 * 主要执行函数：尝试续期
 * @param {number} attempt - 当前尝试次数
 */
async function renewAttempt(attempt = 1) {
    const browser = await puppeteer.launch({
        defaultViewport: { width: 1080, height: 1024 },
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const [page] = await browser.pages()
    const userAgent = await browser.userAgent()
    await page.setUserAgent(userAgent.replace('Headless', ''))

    try {
        console.log(`🔁 第 ${attempt} 次尝试`)
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
        await page.type('#memberid', process.env.EMAIL)
        await page.type('#user_password', process.env.PASSWORD)
        await page.click('text=ログインする')
        await page.waitForNavigation({ waitUntil: 'networkidle2' })

        await page.click('a[href^="/xapanel/xvps/server/detail?id="]')
        await page.click('text=更新する')
        await page.click('text=引き続き無料VPSの利用を継続する')
        await page.waitForNavigation({ waitUntil: 'networkidle2' })

        const captchaImg = await page.$('img[src^="data:"]')
        if (captchaImg) {
            console.log('🔎 发现验证码，开始识别...')
            const imgBase64 = await page.$eval('img[src^="data:"]', img => img.src.split(',')[1])
            const captchaId = await fetch('http://2captcha.com/in.php', {
                method: 'POST',
                body: new URLSearchParams({
                    method: 'base64',
                    key: process.env.CAPTCHA_API_KEY,
                    body: imgBase64,
                    json: '1',
                })
            }).then(res => res.json()).then(json => json.request)

            console.log(`⏳ 等待验证码识别结果, ID: ${captchaId}`)
            const code = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error('验证码识别超时 (90秒)'));
                }, 90000);

                const interval = setInterval(async () => {
                    const result = await fetch(`http://2captcha.com/res.php?key=${process.env.CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`).then(res => res.json());
                    if (result.status === 1) {
                        clearTimeout(timeout);
                        clearInterval(interval);
                        resolve(result.request);
                    } else if (result.request !== 'CAPCHA_NOT_READY') {
                        clearTimeout(timeout);
                        clearInterval(interval);
                        reject(new Error(`验证码识别失败: ${result.request}`));
                    }
                }, 5000);
            });
            
            console.log(`✅ 验证码识别成功: ${code}`)
            await page.type('[placeholder="上の画像の数字を入力"]', code)
            await page.click('text=無料VPSの利用を継続する')
        } else {
            console.log('✅ 未检测到验证码，直接点击续期按钮')
            await page.click('text=無料VPSの利用を継続する')
        }

        await page.waitForTimeout(3000)
        
        console.log('📸 正在截取成功页面...')
        const screenshotBase64 = await page.screenshot({ encoding: 'base64' })
        const imageUrl = await uploadToChevereto(screenshotBase64)

        let msg = 'XServer VPS 自动续期成功 ✅\n\n'
        if (imageUrl) {
            msg += `![续期成功](${imageUrl})\n[点击查看大图](${imageUrl})`
        }

        await sendServerNotify('XServer VPS 自动续期成功 ✅', msg)
        console.log('🎉 成功！')

    } catch (e) {
        console.error('❌ 主流程发生严重错误:', e)
        let imageUrl = null;

        try {
            console.log('📸 尝试截取错误快照 (Base64)...');
            // 即使主流程失败，也尝试生成 Base64 截图并上传
            const errorScreenshotBase64 = await page.screenshot({ encoding: 'base64' });
            imageUrl = await uploadToChevereto(errorScreenshotBase64);
        } catch (screenshotError) {
            console.error('❌ 截取错误快照失败！可能是浏览器已崩溃:', screenshotError);
        }

        let msg = `脚本执行失败：\n\n**主错误信息:**\n\`\`\`\n${e.message || e.toString()}\n\`\`\`\n`
        if (imageUrl) {
            msg += `\n![错误截图](${imageUrl})\n[查看原图](${imageUrl})`
        } else {
            msg += "\n错误截图上传失败，请检查运行日志。"
        }

        await sendServerNotify(`XServer VPS 第${attempt}次失败 ❌`, msg)

        if (attempt < MAX_RETRIES) {
            console.log('⏳ 重试中...')
        } else {
            console.log('🚫 达到最大重试次数，终止')
        }
        
        if (attempt < MAX_RETRIES) {
            await browser.close()
            await renewAttempt(attempt + 1)
        }

    } finally {
        if (browser && browser.process() != null) {
             await browser.close();
             console.log('🚪 浏览器已关闭。');
        }
    }
}

// 启动脚本
await renewAttempt()
