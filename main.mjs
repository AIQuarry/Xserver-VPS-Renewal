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

// 检测Cloudflare验证状态
async function checkCFVerification(page) {
  try {
    // 检查验证框是否成功显示
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 5000 })
    
    // 检查成功标志
    const isSuccess = await page.evaluate(() => {
      const container = document.querySelector('.cf-turnstile');
      return container && container.classList.contains('cf-turnstile-success');
    });
    
    if (isSuccess) {
      console.log('✅ Cloudflare验证已通过');
      return true;
    }
    
    // 检查错误标志
    const isError = await page.evaluate(() => {
      const container = document.querySelector('.cf-turnstile');
      return container && container.classList.contains('cf-turnstile-error');
    });
    
    if (isError) {
      console.log('❌ Cloudflare验证失败');
      return false;
    }
    
    // 检查隐藏输入框是否有值
    const hasToken = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input && input.value.length > 10;
    });
    
    return hasToken;
  } catch (e) {
    console.log('Cloudflare验证状态检测失败:', e.message);
    return false;
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

  // Turnstile 验证 (带重试机制)
  let cfVerified = false;
  let retryCount = 0;
  
  while (!cfVerified && retryCount < 3) {
    console.log(`尝试Cloudflare验证 (第 ${retryCount + 1} 次)`);
    const cfFrame = page.frames().find(f =>
      f.url().includes('challenges.cloudflare.com') &&
      f.url().includes('/turnstile/if/')
    )
    
    if (cfFrame) {
      const sitekey = (cfFrame.url().match(/\/([0-9A-Za-z]{20,})\//) || [])[1]
      const token = await solveTurnstileV2(sitekey, page.url())
      
      await page.evaluate(t => {
        // 尝试找到现有输入框或创建新输入框
        let inp = document.querySelector('input[name="cf-turnstile-response"]');
        if (!inp) {
          inp = document.createElement('input');
          inp.type = 'hidden';
          inp.name = 'cf-turnstile-response';
          document.forms[0].appendChild(inp);
        }
        inp.value = t;
        
        // 尝试触发验证成功事件
        const event = new Event('cf-turnstile-success', { bubbles: true });
        inp.dispatchEvent(event);
        
        // 尝试更新验证框状态
        const container = document.querySelector('.cf-turnstile');
        if (container) {
          container.classList.add('cf-turnstile-success');
          container.classList.remove('cf-turnstile-error');
        }
      }, token);
      
      // 等待可能的页面更新
      await setTimeout(3000);
      
      // 检查验证是否真正通过
      cfVerified = await checkCFVerification(page);
      
      if (!cfVerified) {
        console.log('Cloudflare验证未通过，准备重试...');
        // 刷新验证框
        await page.evaluate(() => {
          const container = document.querySelector('.cf-turnstile');
          if (container) {
            container.innerHTML = ''; // 清空容器
            if (window.turnstile) {
              window.turnstile.render(container, {
                sitekey: container.dataset.sitekey,
                callback: function(token) {
                  document.querySelector('input[name="cf-turnstile-response"]').value = token;
                }
              });
            }
          }
        });
      }
    } else {
      console.log('未找到Cloudflare验证框，可能不需要验证');
      cfVerified = true; // 没有验证框也算通过
    }
    
    retryCount++;
    if (!cfVerified && retryCount < 3) await setTimeout(2000); // 重试前等待
  }
  
  if (!cfVerified) {
    throw new Error('Cloudflare验证失败，重试次数用尽');
  }

  // 图像验证码（使用原本验证码服务）
  const body = await page.$eval('img[src^="data:"]', el => el.src)
  const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
    method: 'POST',
    body
  }).then(r => r.text())
  console.log('图形验证码结果:', code)
  await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

  // 点击续订按钮（带状态检测）
  const btn = await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 30000, visible: true }).catch(() => null)
  
  if (!btn) {
    throw new Error('无法找到续费按钮');
  }
  
  // 检查按钮是否可用
  const isDisabled = await btn.evaluate(b => b.disabled);
  if (isDisabled) {
    throw new Error('续费按钮处于禁用状态');
  }
  
  await btn.click();
  console.log('✅ 续费按钮点击成功');
  
  // 检查操作结果
  await page.waitForSelector('.alert-success, #success-message', { timeout: 10000 }).catch(() => {
    throw new Error('续费操作完成，但未检测到成功提示');
  });
  
  console.log('✅ 续费操作成功确认');
  
  // 等待5秒确保页面稳定
  console.log('等待5秒确保页面稳定...');
  await setTimeout(5000);

} catch (e) {
  console.error('❌ 发生错误:', e)
  await page.screenshot({ path: 'failure.png', fullPage: true })
  console.log('📸 已保存失败截图：failure.png')
  throw e // 重新抛出错误以便外部处理
} finally {
  await recorder.stop()
  await browser.close()
}
