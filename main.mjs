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

// 处理 iframe 版 Turnstile 验证
async function handleIframeTurnstile(page) {
  console.log('检测到 iframe 版 Turnstile 验证')
  
  // 查找包含 Turnstile 验证的 iframe
  const cfFrame = page.frames().find(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/')
  )
  
  if (!cfFrame) {
    console.log('未找到 Turnstile iframe')
    return false
  }
  
  // 从 iframe URL 提取 sitekey
  const sitekeyMatch = cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//)
  if (!sitekeyMatch || !sitekeyMatch[1]) {
    console.log('无法从 iframe URL 提取 sitekey')
    return false
  }
  
  const sitekey = sitekeyMatch[1]
  console.log('提取到 sitekey:', sitekey)
  
  // 使用 2Captcha 解决验证
  const token = await solveTurnstileV2(sitekey, page.url())
  console.log('获取到 Turnstile token:', token.substring(0, 10) + '...')
  
  // 将 token 注入页面
  await page.evaluate((t) => {
    // 查找或创建隐藏输入字段
    let input = document.querySelector('input[name="cf-turnstile-response"]')
    if (!input) {
      input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'cf-turnstile-response'
      document.forms[0].appendChild(input)
    }
    input.value = t
    
    // 尝试触发验证成功事件
    const event = new Event('input', { bubbles: true })
    input.dispatchEvent(event)
    
    console.log('Turnstile token 已注入')
  }, token)
  
  return true
}

// 处理内联版 Turnstile 验证
async function handleInlineTurnstile(page) {
  console.log('检测到内联版 Turnstile 验证')
  
  try {
    // 查找并点击验证框
    const checkboxLabel = await page.waitForSelector('label.cb-lb', { visible: true, timeout: 5000 })
    if (!checkboxLabel) {
      console.log('未找到验证框标签')
      return false
    }
    
    // 点击验证框
    await checkboxLabel.click()
    console.log('已点击验证框')
    
    // 等待验证成功
    await page.waitForSelector('#success', { visible: true, timeout: 30000 })
    console.log('验证成功状态已显示')
    
    return true
  } catch (e) {
    console.log('处理内联验证时出错:', e.message)
    return false
  }
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

  // 检测并处理 Turnstile 验证
  console.log('检测 Turnstile 验证类型...')
  
  // 尝试处理 iframe 版验证
  const iframeDetected = await page.$('iframe[src*="turnstile"]') !== null
  if (iframeDetected) {
    console.log('检测到 iframe 版 Turnstile 验证')
    const iframeSuccess = await handleIframeTurnstile(page)
    if (!iframeSuccess) {
      throw new Error('iframe 版验证处理失败')
    }
  } 
  // 尝试处理内联版验证
  else {
    console.log('未检测到 iframe 版验证，尝试检测内联版')
    const inlineDetected = await page.$('label.cb-lb') !== null
    
    if (inlineDetected) {
      console.log('检测到内联版 Turnstile 验证')
      const inlineSuccess = await handleInlineTurnstile(page)
      if (!inlineSuccess) {
        throw new Error('内联版验证处理失败')
      }
    } else {
      console.log('未检测到任何形式的 Turnstile 验证，继续执行')
    }
  }

  // 图像验证码（使用原本验证码服务）
  const captchaImg = await page.$('img[src^="data:"]')
  if (captchaImg) {
    const body = await page.$eval('img[src^="data:"]', el => el.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
      method: 'POST',
      body
    }).then(r => r.text())
    console.log('图形验证码结果:', code)
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
  } else {
    console.log('未检测到图像验证码')
  }

  // 点击续订按钮
  const btnSelector = 'text=無料VPSの利用を継続する'
  const btn = await page.waitForSelector(btnSelector, { timeout: 30000, visible: true })
    .catch(() => null)
  
  if (!btn) {
    throw new Error('无法找到续费按钮')
  }
  
  // 检查按钮状态
  const isDisabled = await btn.evaluate(b => b.disabled)
  if (isDisabled) {
    throw new Error('续费按钮处于禁用状态')
  }
  
  await btn.click()
  console.log('✅ 续费按钮点击成功')
  
  // 等待操作完成
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
    console.log('页面导航完成')
  } catch (e) {
    console.log('等待导航超时，检查成功状态')
  }
  
  // 检查操作结果
  const successIndicator = await page.$('.alert-success, #success-message, .text-success')
  if (successIndicator) {
    const successText = await successIndicator.evaluate(el => el.textContent.trim())
    console.log(`✅ 续费成功: ${successText.substring(0, 50)}...`)
  } else {
    throw new Error('未检测到续费成功提示')
  }
  
  // 等待5秒确保页面稳定
  console.log('等待5秒确保页面稳定...')
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
