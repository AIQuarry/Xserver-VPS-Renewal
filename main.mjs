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
  console.log('处理 Cloudflare Turnstile 验证...')
  
  // 查找包含 /turnstile/if/ 的 iframe
  const cfFrame = page.frames().find(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/if/')
  )
  
  if (!cfFrame) {
    console.log('未找到 /turnstile/if/ 验证框')
    return false
  }
  
  // 从 URL 提取 sitekey
  const sitekeyMatch = cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//)
  if (!sitekeyMatch || !sitekeyMatch[1]) {
    console.log('无法从 URL 提取 sitekey')
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
    
    // 触发输入事件
    const event = new Event('input', { bubbles: true })
    input.dispatchEvent(event)
    
    // 尝试触发验证成功事件
    try {
      const successEvent = new Event('cf-turnstile-success', { bubbles: true })
      input.dispatchEvent(successEvent)
    } catch (e) {}
  }, token)
  
  console.log('✅ Turnstile token 已注入')
  return true
}

// 检查续订按钮状态
async function checkRenewButton(page) {
  const btnSelector = 'text=無料VPSの利用を継続する'
  
  // 查找按钮
  const btn = await page.$(btnSelector).catch(() => null)
  if (!btn) {
    console.log('未找到续订按钮')
    return { found: false }
  }
  
  // 检查按钮是否可见
  const isVisible = await btn.isIntersectingViewport()
  if (!isVisible) {
    console.log('按钮不可见，尝试滚动到视图')
    await btn.scrollIntoView()
    await setTimeout(1000)
  }
  
  // 检查按钮是否禁用
  const isDisabled = await btn.evaluate(b => b.disabled)
  
  // 检查禁用原因
  let disabledReason = null
  if (isDisabled) {
    disabledReason = await page.evaluate(() => {
      // 查找关联的错误消息
      const errorElement = document.querySelector('.error-message, .invalid-feedback, .text-danger')
      return errorElement ? errorElement.textContent.trim() : '未知原因'
    }).catch(() => '未知原因')
  }
  
  return {
    found: true,
    element: btn,
    disabled: isDisabled,
    reason: disabledReason
  }
}

// 重新验证流程
async function retryVerification(page) {
  console.log('开始重新验证流程...')
  
  // 1. 重新进行 Cloudflare 验证
  const cfResult = await handleTurnstileVerification(page)
  if (!cfResult) {
    console.log('Cloudflare 验证失败')
    return false
  }
  
  // 等待验证状态更新
  await setTimeout(3000)
  
  // 2. 检查图像验证码是否需要重新输入
  try {
    const captchaImg = await page.$('img[src^="data:"]')
    if (captchaImg) {
      console.log('重新处理图像验证码')
      const body = await captchaImg.evaluate(el => el.src)
      const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body
      }).then(r => r.text())
      
      await page.locator('[placeholder="上の画像の数字を入力"]').fill('')
      await setTimeout(500)
      await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
      console.log('图像验证码已重新输入:', code)
    }
  } catch (e) {
    console.log('图像验证码处理失败:', e.message)
  }
  
  return true
}

try {
  if (process.env.PROXY_SERVER) {
    const { username, password } = new URL(process.env.PROXY_SERVER)
    if (username && password) await page.authenticate({ username, password })
  }

  // 登录并跳转续订页面
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
  await page.locator('#memberid').fill(process.env.EMAIL)
  await page.locator('#user_password').fill(process.env.PASSWORD)
  await page.locator('text=ログインする').click()
  await page.waitForNavigation({ waitUntil: 'networkidle2' })
  await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
  await page.locator('text=更新する').click()
  await page.locator('text=引き続き無料VPSの利用を継続する').click()
  await page.waitForNavigation({ waitUntil: 'networkidle2' })

  // 初始验证
  const hasTurnstile = page.frames().some(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/if/')
  )
  
  if (hasTurnstile) {
    await handleTurnstileVerification(page)
  }

  // 处理图像验证码
  try {
    const captchaImg = await page.waitForSelector('img[src^="data:"]', { timeout: 5000 })
    const body = await captchaImg.evaluate(el => el.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
      method: 'POST',
      body
    }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    console.log('图形验证码结果:', code)
  } catch (e) {
    console.log('未检测到图像验证码')
  }

  // 按钮状态检查和重试机制
  let retryCount = 0
  const maxRetries = 2
  let btnStatus = await checkRenewButton(page)
  
  while (btnStatus.found && btnStatus.disabled && retryCount < maxRetries) {
    console.log(`按钮被禁用 (原因: ${btnStatus.reason}), 尝试重新验证 (${retryCount + 1}/${maxRetries})`)
    
    // 重新验证
    const retrySuccess = await retryVerification(page)
    if (!retrySuccess) {
      console.log('重新验证失败')
      break
    }
    
    // 重新检查按钮状态
    await setTimeout(2000)
    btnStatus = await checkRenewButton(page)
    
    retryCount++
  }

  // 最终按钮状态检查
  if (!btnStatus.found) {
    throw new Error('无法找到续订按钮')
  }
  
  if (btnStatus.disabled) {
    throw new Error(`续订按钮被禁用: ${btnStatus.reason}`)
  }
  
  // 点击按钮前截图
  await page.screenshot({ path: 'before_click.png' })
  
  // 点击按钮
  console.log('点击续订按钮...')
  await btnStatus.element.click()
  console.log('✅ 续费按钮点击成功')
  
  // 等待操作完成
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
    console.log('页面导航完成')
  } catch (e) {
    console.log('等待导航超时，继续检查结果')
  }
  
  // 简单检查是否出现成功文本
  const successDetected = await page.evaluate(() => {
    return document.body.textContent.includes('更新が完了しました') || 
           document.body.textContent.includes('更新完了')
  })
  
  if (successDetected) {
    console.log('✅ 续费操作成功')
  } else {
    console.log('未检测到明确的成功消息')
  }
  
  await setTimeout(5000)

} catch (e) {
  console.error('❌ 发生错误:', e)
  await page.screenshot({ path: 'failure.png', fullPage: true })
  console.log('📸 已保存失败截图：failure.png')
  throw e
} finally {
  await recorder.stop()
  await browser.close()
}
