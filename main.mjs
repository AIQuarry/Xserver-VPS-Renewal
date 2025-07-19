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
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task:{ type:'TurnstileTaskProxyless', websiteURL:pageUrl, websiteKey:sitekey }
    })
  })
  const j = await res.json()
  if (j.errorId) throw new Error('Turnstile createTask 错误: '+j.errorCode)
  for (let i=0;i<30;i++){
    await setTimeout(5000)
    const r2 = await fetch('https://api.2captcha.com/getTaskResult', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ clientKey:apiKey, taskId:j.taskId })
    })
    const j2 = await r2.json()
    if (j2.errorId) throw new Error('Turnstile getTaskResult 错误: '+j2.errorCode)
    if (j2.status === 'ready') return j2.solution.token
  }
  throw new Error('Turnstile 验证超时')
}

async function solveImageCaptcha(bodyDataUrl) {
  const apiKey = process.env.TWOCAPTCHA_KEY
  const res = await fetch('https://api.2captcha.com/createTask', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type:'ImageToTextTask', body: bodyDataUrl }
    })
  })
  const j = await res.json()
  if (j.errorId) throw new Error('ImageCaptcha createTask 错误: '+j.errorCode)
  for (let i=0;i<30;i++){
    await setTimeout(5000)
    const r2 = await fetch('https://api.2captcha.com/getTaskResult', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ clientKey:apiKey, taskId:j.taskId })
    })
    const j2 = await r2.json()
    if (j2.errorId) throw new Error('ImageCaptcha getTaskResult 错误: '+j2.errorCode)
    if (j2.status === 'ready') return j2.solution.text
  }
  throw new Error('ImageCaptcha 超时')
}

try {
  if (process.env.PROXY_SERVER) {
    const {username,password} = new URL(process.env.PROXY_SERVER)
    if (username && password) await page.authenticate({ username, password })
  }

  // 登录并跳转续订页
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil:'networkidle2' })
  await page.locator('#memberid').fill(process.env.EMAIL)
  await page.locator('#user_password').fill(process.env.PASSWORD)
  await page.locator('text=ログインする').click()
  await page.waitForNavigation({ waitUntil:'networkidle2' })
  await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
  await page.locator('text=更新する').click()
  await page.locator('text=引き続き無料VPSの利用を継続する').click()
  await page.waitForNavigation({ waitUntil:'networkidle2' })

  // Turnstile 验证
  console.log('frames:', page.frames().map(f=>f.url()))
  const cfFrame = page.frames().find(f=>f.url().includes('challenges.cloudflare.com') && f.url().includes('/turnstile/if/'))
  if (cfFrame) {
    const sitekey = (cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//)||[])[1]
    const token = await solveTurnstileV2(sitekey, page.url())
    await page.evaluate(t=>{
      const inp = document.querySelector('input[name="cf-turnstile-response"]') || (() => {
        const i = document.createElement('input')
        i.type='hidden'; i.name='cf-turnstile-response'
        document.forms[0].appendChild(i)
        return i
      })()
      inp.value = t
      document.forms[0].submit()
    }, token)
    await page.waitForNavigation({ waitUntil:'networkidle2' })
  }

  // 图像验证码
  const imgData = await page.$eval('img[src^="data:"]', el=>el.src)
  const imgCode = await solveImageCaptcha(imgData)
  await page.locator('[placeholder="上の画像の数字を入力"]').fill(imgCode)

  // 点击续订
  const btn = await page.waitForSelector('text=無料VPSの利用を継続する',{timeout:30000})
  await btn.click()
  console.log('✅ 续订提交成功')

} catch (e) {
  console.error('❌ 发生错误:', e)
  await page.screenshot({ path:'failure.png', fullPage:true })
  console.log('📸 已保存失败截图 failure.png')
} finally {
  await setTimeout(5000)
  await recorder.stop()
  await browser.close()
}
