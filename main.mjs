import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha'
import { setTimeout } from 'node:timers/promises'
import { executablePath } from 'puppeteer'

// 应用插件
puppeteer.use(StealthPlugin())
puppeteer.use(RecaptchaPlugin({
  provider: {
    id: '2captcha',
    token: process.env.TWO_CAPTCHA_API_KEY
  },
  visualFeedback: true
}))

// 浏览器参数
const args = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  '--window-position=0,0',
  '--ignore-certificate-errors',
  '--ignore-certificate-errors-spki-list',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-zygote',
  '--no-first-run',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--enable-automation',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-datasaver-prompt',
  '--disable-domain-reliability',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
  '--password-store=basic',
  '--use-mock-keychain',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  '--headless=new' // 关键：使用新的Headless模式
]

// 添加代理设置
if (process.env.PROXY_SERVER) {
  const proxy_url = new URL(process.env.PROXY_SERVER)
  proxy_url.username = ''
  proxy_url.password = ''
  args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

// 创建浏览器实例
const browser = await puppeteer.launch({
  headless: 'new', // 使用新的Headless模式
  defaultViewport: { width: 1280, height: 800 },
  args,
  executablePath: executablePath(),
  ignoreHTTPSErrors: true
})

const [page] = await browser.pages()

// 隐藏自动化痕迹
await page.evaluateOnNewDocument(() => {
  // 隐藏webdriver属性
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false
  })
  
  // 覆盖plugins属性
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3]
  })
  
  // 覆盖languages属性
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ja-JP', 'ja', 'en-US', 'en']
  })
})

try {
  // 代理认证
  if (process.env.PROXY_SERVER) {
    const { username, password } = new URL(process.env.PROXY_SERVER)
    if (username && password) {
      await page.authenticate({ username, password })
    }
  }

  // 添加随机鼠标移动
  await page.mouse.move(Math.random() * 100, Math.random() * 100)
  
  // 导航到登录页面
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })
  
  // 模拟人类输入
  await page.type('#memberid', process.env.EMAIL, { delay: 50 + Math.random() * 50 })
  await page.type('#user_password', process.env.PASSWORD, { delay: 50 + Math.random() * 50 })
  
  // 随机等待后点击登录
  await setTimeout(1000 + Math.random() * 2000)
  const loginButton = await page.waitForSelector('text=ログインする', { timeout: 10000 })
  await Promise.all([
    loginButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  ])
  
  // 查找服务器详情链接
  const serverLinks = await page.$$('a[href^="/xapanel/xvps/server/detail?id="]')
  if (serverLinks.length > 0) {
    await Promise.all([
      serverLinks[0].click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
    ])
  } else {
    throw new Error('未找到服务器详情链接')
  }
  
  // 点击更新按钮
  const updateButton = await page.waitForSelector('text=更新する', { timeout: 15000 })
  await Promise.all([
    updateButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  ])
  
  // 点击继续使用
  const continueButton = await page.waitForSelector('text=引き続き無料VPSの利用を継続する', { timeout: 15000 })
  await Promise.all([
    continueButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  ])
  
  // 处理图片验证码
  await page.waitForSelector('img[src^="data:"]', { timeout: 10000 })
  const body = await page.$eval('img[src^="data:"]', img => img.src)
  const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { 
    method: 'POST', 
    body 
  }).then(r => r.text())
  
  // 模拟人类输入验证码
  await page.type('[placeholder="上の画像の数字を入力"]', code, { delay: 100 + Math.random() * 100 })
  
  // 处理Cloudflare Turnstile验证
  try {
    // 等待验证框架加载
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 10000 })
    
    // 使用puppeteer-extra插件解决验证
    await page.solveRecaptchas()
    
    // 等待验证完成
    await setTimeout(3000)
    
    console.log('Cloudflare验证已解决')
  } catch (e) {
    console.warn('Cloudflare验证处理失败:', e.message)
  }
  
  // 点击继续按钮
  const confirmButton = await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 10000 })
  await Promise.all([
    confirmButton.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  ])
  
  // 检查是否成功
  try {
    await page.waitForSelector('text=更新が完了しました', { timeout: 10000 })
    console.log('VPS续约成功!')
  } catch (e) {
    // 保存最终页面截图
    await page.screenshot({ path: 'result.png', fullPage: true })
    console.log('续约完成，但未检测到成功文本 - 已保存result.png')
  }
} catch (e) {
  console.error('流程出错:', e)
  
  // 保存错误截图
  await page.screenshot({ path: 'error.png', fullPage: true })
} finally {
  await browser.close()
}
