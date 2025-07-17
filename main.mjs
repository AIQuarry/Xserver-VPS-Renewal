import puppeteer from 'puppeteer'
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder'
import fs from 'fs'
import path from 'path'
import { setTimeout } from 'node:timers/promises'

const MAX_RETRIES = 2
const SCREENSHOT_DIR = './'
const RECORDING_PATH = 'recording.webm'

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR)
}

async function sendServerNotify(title, message) {
    await fetch(`https://sctapi.ftqq.com/${process.env.SCKEY_SENDKEY}.send`, {
        method: 'POST',
        body: new URLSearchParams({ title, desp: message }),
    })
}

async function renewAttempt(attempt = 1) {
    const browser = await puppeteer.launch({
        defaultViewport: { width: 1080, height: 1024 },
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const [page] = await browser.pages()
    const userAgent = await browser.userAgent()
    await page.setUserAgent(userAgent.replace('Headless', ''))

    // 初始化录屏器
    const recorder = new PuppeteerScreenRecorder(page, {
        followNewTab: true,
        fps: 25,
        videoFrame: {
            width: 1080,
            height: 1024,
        },
        aspectRatio: '4:3',
    })

    try {
        console.log(`🔁 第 ${attempt} 次尝试`)
        await recorder.start(RECORDING_PATH) // 开始录制

        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', {
            waitUntil: 'networkidle2',
        })
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
            const imgBase64 = await page.$eval(
                'img[src^="data:"]',
                (img) => img.src.split(',')[1]
            )
            const captchaId = await fetch('http://2captcha.com/in.php', {
                method: 'POST',
                body: new URLSearchParams({
                    method: 'base64',
                    key: process.env.CAPTCHA_API_KEY,
                    body: imgBase64,
                    json: '1',
                }),
            })
                .then((res) => res.json())
                .then((json) => json.request)

            console.log(`⏳ 等待验证码识别结果, ID: ${captchaId}`)
            const code = await new Promise((resolve) => {
                const interval = setInterval(async () => {
                    const result = await fetch(
                        `http://2captcha.com/res.php?key=${process.env.CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`
                    ).then((res) => res.json())
                    if (result.status === 1) {
                        clearInterval(interval)
                        resolve(result.request)
                    } else if (result.request !== 'CAPCHA_NOT_READY') {
                        clearInterval(interval)
                        console.error('❌ 验证码识别失败:', result.request)
                        resolve(null)
                    }
                }, 5000)
            })

            if (!code) throw new Error('验证码识别失败或超时。')

            console.log(`✅ 验证码识别成功: ${code}`)
            await page.type('[placeholder="上の画像の数字を入力"]', code)
            await page.click('text=無料VPSの利用を継続する')
        } else {
            console.log('✅ 未检测到验证码，直接点击续期按钮')
            await page.click('text=無料VPSの利用を継続する')
        }

        await page.waitForTimeout(3000)

        // 截图保存
        const successPath = path.join(SCREENSHOT_DIR, 'success.png')
        await page.screenshot({ path: successPath })

        await sendServerNotify('XServer VPS 自动续期成功 ✅', `本次续期成功，截图保存在：\`${successPath}\`，录屏文件：\`${RECORDING_PATH}\``)
        console.log('🎉 成功！')
    } catch (e) {
        console.error('❌ 失败：', e)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const screenshotPath = path.join(SCREENSHOT_DIR, `error-${timestamp}.png`)
        await page.screenshot({ path: screenshotPath })

        await sendServerNotify(`XServer VPS 第${attempt}次失败 ❌`,
            `错误信息：\n\n\`\`\`\n${e.message || e.toString()}\n\`\`\`\n截图：\`${screenshotPath}\`\n录屏文件：\`${RECORDING_PATH}\``)

        if (attempt < MAX_RETRIES) {
            console.log('⏳ 重试中...')
            await recorder.stop()
            await browser.close()
            await renewAttempt(attempt + 1)
            return
        } else {
            console.log('🚫 达到最大重试次数，终止')
        }
    } finally {
        await recorder.stop() // 结束录制
        await setTimeout(3000)
        await browser.close()
    }
}

// 启动脚本
await renewAttempt()
