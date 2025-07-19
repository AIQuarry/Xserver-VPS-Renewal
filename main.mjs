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

// 检测并处理 /turnstile/if/ 类型的验证
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
  
  // 等待验证状态更新
  await setTimeout(3000)
  
  // 检查验证是否成功
  const isVerified = await page.evaluate(() => {
    const container = document.querySelector('.cf-turnstile')
    if (!container) return false
    
    // 检查成功状态类
    if (container.classList.contains('cf-turnstile-success')) {
      return true
    }
    
    // 检查隐藏输入值
    const input = document.querySelector('input[name="cf-turnstile-response"]')
    return input && input.value.length > 50
  })
  
  if (isVerified) {
    console.log('✅ Turnstile 验证成功')
    return true
  }
  
  console.log('⚠️ 验证状态未更新，尝试提交表单')
  
  // 如果验证状态未更新，尝试提交表单
  await page.evaluate(() => {
    const form = document.forms[0]
    if (form) {
      form.submit()
    }
  })
  
  // 等待可能的页面导航
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
    console.log('表单提交后页面已导航')
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

  // 处理 Turnstile 验证
  const turnstileDetected = await page.frames().some(f => 
    f.url().includes('challenges.cloudflare.com') && 
    f.url().includes('/turnstile/if/')
  )
  
  if (turnstileDetected) {
    console.log('检测到 /turnstile/if/ 验证')
    const verificationSuccess = await handleTurnstileVerification(page)
    
    if (!verificationSuccess) {
      throw new Error('Cloudflare Turnstile 验证失败')
    }
    
    // 验证后可能需要重新等待页面稳定
    await page.waitForLoadState('networkidle', { timeout: 10000 })
  } else {
    console.log('未检测到 /turnstile/if/ 验证，继续执行')
  }

  // 图像验证码处理
  try {
    const captchaImg = await page.waitForSelector('img[src^="data:"]', { timeout: 5000 })
    if (captchaImg) {
      const body = await page.$eval('img[src^="data:"]', el => el.src)
      const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body
      }).then(r => r.text())
      console.log('图形验证码结果:', code)
      await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    }
  } catch (e) {
    console.log('未检测到图像验证码:', e.message)
  }

  // 点击续订按钮
  const btnSelector = 'text=無料VPSの利用を継続する'
  let btn = await page.$(btnSelector).catch(() => null)
  
  if (!btn) {
    console.log('首次查找按钮失败，尝试重新查找')
    btn = await page.waitForSelector(btnSelector, { timeout: 10000, visible: true }).catch(() => null)
  }
  
  if (!btn) {
    throw new Error('无法找到续费按钮')
  }
  
  // 确保按钮可见并可点击
  await btn.scrollIntoViewIfNeeded()
  
  // 检查按钮状态
  const isDisabled = await btn.evaluate(b => b.disabled)
  if (isDisabled) {
    // 尝试检查禁用原因
    const disabledReason = await page.evaluate(selector => {
      const btn = document.querySelector(selector)
      if (!btn) return '按钮不存在'
      if (btn.disabled) {
        // 检查关联的错误消息
        const errorElement = btn.closest('form')?.querySelector('.error-message, .invalid-feedback')
        return errorElement ? errorElement.textContent.trim() : '未知原因'
      }
      return null
    }, btnSelector)
    
    throw new Error(`续费按钮处于禁用状态: ${disabledReason || '未知原因'}`)
  }
  
  // 点击按钮前截图
  await page.screenshot({ path: 'before_click.png' })
  
  // 点击按钮
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
  const successSelectors = [
    '.alert-success', 
    '#success-message', 
    '.text-success',
    'text=更新が完了しました',
    'text=更新完了'
  ]
  
  let successIndicator = null
  for (const selector of successSelectors) {
    successIndicator = await page.$(selector).catch(() => null)
    if (successIndicator) break
  }
  
  if (successIndicator) {
    const successText = await successIndicator.evaluate(el => el.textContent.trim())
    console.log(`✅ 续费成功: ${successText.substring(0, 50)}${successText.length > 50 ? '...' : ''}`)
  } else {
    // 检查是否有错误消息
    const errorSelectors = [
      '.alert-danger',
      '.error-message',
      '.text-danger',
      'text=エラー',
      'text=エラーが発生しました'
    ]
    
    let errorMessage = '未检测到续费成功提示'
    for (const selector of errorSelectors) {
      const errorElement = await page.$(selector).catch(() => null)
      if (errorElement) {
        errorMessage = await errorElement.evaluate(el => el.textContent.trim())
        break
      }
    }
    
    throw new Error(errorMessage)
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
