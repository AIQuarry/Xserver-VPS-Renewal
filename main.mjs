import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'fs'
import FormData from 'form-data'

const MAX_RETRIES = 2

async function uploadToChevereto(filePath) {
    const form = new FormData()
    form.append('key', 'chv_f0i_0d74abac3e3526ebade63f275b49c6471d026a442b1ceae43bd3a80792a346b3f567e64e11e07624cdb17a1398938c753814e3c8744337bb6bcfe8202d9f57d1')
    form.append('format', 'json')
    form.append('source', fs.createReadStream(filePath))

    const response = await fetch('https://img.piacg.eu.org/api/1/upload', {
        method: 'POST',
        body: form
    })

    const result = await response.json()
    if (result.status_code === 200) {
        console.log('✅ 上传成功:', result.image.url)
        return result.image.url
    } else {
        console.error('❌ 上传失败:', result)
        return null
    }
}

async function sendServerNotify(title, message) {
    await fetch(`https://sctapi.ftqq.com/${process.env.SCKEY_SENDKEY}.send`, {
        method: 'POST',
        body: new URLSearchParams({
            title,
            desp: message,
        })
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

    try {
        console.log(`🔁 第 ${attempt} 次尝试`)
        await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
        await page.locator('#memberid').fill(process.env.EMAIL)
        await page.locator('#user_password').fill(process.env.PASSWORD)
        await page.locator('text=ログインする').click()
        await page.waitForNavigation({ waitUntil: 'networkidle2' })

        await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
        await page.locator('text=更新する').click()
        await page.locator('text=引き続き無料VPSの利用を継続する').click()
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

            const code = await new Promise((resolve) => {
                const interval = setInterval(async () => {
                    const result = await fetch(`http://2captcha.com/res.php?key=${process.env.CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`)
                        .then(res => res.json())
                    if (result.status === 1) {
                        clearInterval(interval)
                        resolve(result.request)
                    }
                }, 5000)
            })

            await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
            await page.locator('text=無料VPSの利用を継続する').click()
        } else {
            console.log('✅ 未检测到验证码，直接点击续期按钮')
            await page.locator('text=無料VPSの利用を継続する').click()
        }

        await page.waitForTimeout(3000)
        const screenshotPath = './success.png'
        await page.screenshot({ path: screenshotPath })
        const imageUrl = await uploadToChevereto(screenshotPath)

        let msg = 'XServer VPS 自动续期成功 ✅\n\n'
        if (imageUrl) {
            msg += `![续期成功](${imageUrl})\n[点击查看大图](${imageUrl})`
        }

        await sendServerNotify('XServer VPS 自动续期成功 ✅', msg)
        console.log('🎉 成功！')

    } catch (e) {
        console.error('❌ 失败：', e)
        const screenshotPath = './error.png'
        await page.screenshot({ path: screenshotPath })
        const imageUrl = await uploadToChevereto(screenshotPath)

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

// 🔧 启动脚本
await renewAttempt()
