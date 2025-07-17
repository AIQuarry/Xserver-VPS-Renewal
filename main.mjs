import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'fs'
import path from 'path'
import FormData from 'form-data'
import { Buffer } from 'buffer'

const MAX_RETRIES = 2
const SCREENSHOT_DIR = './screenshots'

// 确保截图目录存在
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR)
}

/**
 * 将图片上传到 Chevereto
 * @param {string} source - 图片来源，可以是文件路径或 Base64 编码的字符串
 * @param {'file' | 'base64'} type - 指定来源类型
 * @returns {Promise<string|null>} 成功则返回图片 URL，否则返回 null
 */
async function uploadToChevereto(source, type) {
    const form = new FormData()
    form.append('format', 'json')

    console.log(`🚀 准备上传，类型: ${type}`)

    if (type === 'file') {
        if (!fs.existsSync(source)) {
            console.error(`❌ 文件不存在: ${source}`)
            return null
        }
        form.append('source', fs.createReadStream(source))
    } else if (type === 'base64') {
        const buffer = Buffer.from(source, 'base64')
        form.append('source', buffer, { filename: 'screenshot.png' })
    } else {
        console.error(`❌ 无效的上传类型: ${type}`)
        return null
    }

    try {
        const response = await fetch('https://img.piacg.eu.org/api/1/upload', {
            method: 'POST',
            body: form,
            headers: {
                'X-API-Key': process.env.CHEVERETO_API_KEY,
                ...form.getHeaders(),
            },
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
    await fetch(`https://sctapi.ftqq.com/${process.env.SCKEY_SENDKEY}.send`, {
        method: 'POST',
        body: new URLSearchParams({
            title,
            desp: message,
        }),
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

        // 成功时用Base64上传
        console.log('📸 正在截取页面并直接上传 Base64 数据...')
        const screenshotBase64 = await page.screenshot({ encoding: 'base64' })
        const imageUrl = await uploadToChevereto(screenshotBase64, 'base64')

        let msg = 'XServer VPS 自动续期成功 ✅\n\n'
        if (imageUrl) {
            msg += `![续期成功](${imageUrl})\n[点击查看大图](${imageUrl})`
        }

        await sendServerNotify('XServer VPS 自动续期成功 ✅', msg)
        console.log('🎉 成功！')
    } catch (e) {
        console.error('❌ 失败：', e)

        // 失败时保存带时间戳的截图文件
        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
        const screenshotPath = path.join(
            SCREENSHOT_DIR,
            `error-${timestamp}.png`
        )

        await page.screenshot({ path: screenshotPath })
        const imageUrl = await uploadToChevereto(screenshotPath, 'file')

        // 上传后删除本地截图
        if (fs.existsSync(screenshotPath)) {
            fs.unlinkSync(screenshotPath)
        }

        let msg = `脚本执行失败：\n\n\`\`\`\n${e.message || e.toString()}\n\`\`\`\n`
        if (imageUrl) {
            msg += `\n![错误截图](${imageUrl})\n[查看原图](${imageUrl})`
        }

        await sendServerNotify(`XServer VPS 第${attempt}次失败 ❌`, msg)

        if (attempt < MAX_RETRIES) {
            console.log('⏳ 重试中...')
            await browser.close()
            await renewAttempt(attempt + 1)
            return
        } else {
            console.log('🚫 达到最大重试次数，终止')
        }
    } finally {
        await setTimeout(3000)
        await browser.close()
    }
}

// 启动脚本
await renewAttempt()
