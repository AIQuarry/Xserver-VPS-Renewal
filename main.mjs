import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'


const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
  const proxy_url = new URL(process.env.PROXY_SERVER)
  proxy_url.username = ''
  proxy_url.password = ''
  args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({ defaultViewport: { width:1080, height:1024 }, args })
const [page] = await browser.pages()
await page.setUserAgent((await browser.userAgent()).replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

async function solveTurnstileV2(sitekey, pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_KEY
  const res = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type:'TurnstileTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey }
    })
  })
  const j = await res.json()
  if (j.errorId) throw new Error('Turnstile createTask 错误: '+j.errorCode)
  for (let i = 0; i < 30; i++) {
    await setTimeout(5000)
    const r2 = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId: j.taskId })
    })
    const j2 = await r2.json()
    if (j2.errorId) throw new Error('Turnstile getTaskResult 错误: '+j2.errorCode)
    if (j2.status === 'ready') return j2.solution.token
  }
  throw new Error('Turnstile 验证超时')
}

async function handleTurnstileVerification(page) {
  console.log('检测 Cloudflare Turnstile 验证...')
  
  // 查找包含 /turnstile/if/ 的 iframe
  const cfFrame = page.frames().find(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/if/')
  )
  
  if (!cfFrame) {
    console.log('未找到 /turnstile/if/ 验证框')
    return false
  }
  
  console.log('找到 Turnstile iframe:', cfFrame.url())
  
  // 从 URL 提取 sitekey
  const sitekeyMatch = cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//)
  if (!sitekeyMatch || !sitekeyMatch[1]) {
    console.log('无法从 URL 提取 sitekey:', cfFrame.url())
    return false
  }
  
  const sitekey = sitekeyMatch[1]
  console.log('提取到 sitekey:', sitekey)
  
  // 使用 2Captcha 获取 token
  const token = await solveTurnstileV2(sitekey, page.url())
  console.log('获取到 Turnstile token:', token.substring(0, 10) + '...')
  
  // 将 token 注入页面
  await page.evaluate((t) => {
    let input = document.querySelector('input[name="cf-turnstile-response"]')
    if (!input) {
      input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'cf-turnstile-response'
      document.forms[0].appendChild(input)
    }
    input.value = t
    
    const event = new Event('input', { bubbles: true })
    input.dispatchEvent(event)
  }, token)
  
  // 等待验证状态更新
  await setTimeout(3000)
  
  // 检查验证是否成功
  const isVerified = await page.evaluate(() => {
    const input = document.querySelector('input[name="cf-turnstile-response"]')
    return input && input.value.length > 50
  })
  
  if (isVerified) {
    console.log('✅ Turnstile 验证成功')
    return true
  }
  
  console.log('⚠️ 验证状态未更新，尝试提交表单')
  await page.evaluate(() => {
    const form = document.forms[0]
    if (form) form.submit()
  })
  
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
    return true
  } catch (e) {
    console.log('表单提交后未发生导航')
    return false
  }
}

try {
  if (process.env.PROXY_SERVER) {
    const { username, password } = new URL(process.env.PROXY_SERVER)
    if (username && password) await page.authenticate({ username, password })
  }

  // 登录流程
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
  await page.locator('#memberid').fill(process.env.EMAIL)
  await page.locator('#user_password').fill(process.env.PASSWORD)
  await Promise.all([
    page.locator('text=ログインする').click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ])
  
  // 续订流程
  await Promise.all([
    page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ])
  
  await Promise.all([
    page.locator('text=更新する').click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ])
  
  await Promise.all([
    page.locator('text=引き続き無料VPSの利用を継続する').click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ])

  // 处理验证
  const turnstileDetected = page.frames().some(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/if/')
  )
  
  if (turnstileDetected) {
    const verificationSuccess = await handleTurnstileVerification(page)
    if (!verificationSuccess) throw new Error('Cloudflare 验证失败')
    
    // 替换原来的 waitForLoadState
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {})
  }

  // 图像验证码
  try {
    const captchaImg = await page.waitForSelector('img[src^="data:"]', { timeout: 5000 })
    const body = await captchaImg.evaluate(el => el.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
      method: 'POST',
      body
    }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
  } catch (e) {
    console.log('未检测到图像验证码:', e.message)
  }

  // 续订操作
  const btn = await page.waitForSelector('text=無料VPSの利用を継続する', { 
    timeout: 30000,
    visible: true 
  })
  
  await btn.click()
  console.log('✅ 续费按钮点击成功')
  
  // 等待操作完成
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
  } catch (e) {
    console.log('等待导航超时，检查成功状态')
  }
  
  // 检查结果
  const successText = await page.evaluate(() => {
    const successEl = document.querySelector('.alert-success, #success-message, .text-success') ||
                     document.querySelector('*:contains("更新が完了しました"), *:contains("更新完了")')
    return successEl?.textContent?.trim()
  })
  
  if (successText) {
    console.log(`✅ 续费成功: ${successText.substring(0, 50)}${successText.length > 50 ? '...' : ''}`)
  } else {
    throw new Error('未检测到续费成功提示')
  }
  
  await setTimeout(5000)

} catch (e) {
  console.error('❌ 发生错误:', e)
  await page.screenshot({ path: 'failure.png', fullPage: true })
  throw e
} finally {
  await recorder.stop()
  await browser.close()
}
