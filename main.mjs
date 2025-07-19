import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import TwoCaptcha from '2captcha';

// 直接从环境变量读取
const { EMAIL, PASSWORD, TWOCAPTCHA_KEY, PROXY_SERVER } = process.env;
const solver = new TwoCaptcha.Solver(TWOCAPTCHA_KEY);

(async () => {
  // 1️⃣ 启动 Puppeteer
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY_SERVER) {
    const u = new URL(PROXY_SERVER);
    u.username = '';
    u.password = '';
    args.push(`--proxy-server=${u}`.replace(/\/$/, ''));
  }
  const browser = await puppeteer.launch({ defaultViewport: { width: 1080, height: 1024 }, args });
  const [page] = await browser.pages();
  page.setDefaultNavigationTimeout(0);
  await page.setUserAgent((await browser.userAgent()).replace('Headless', ''));
  const recorder = await page.screencast({ path: 'recording.webm' });

  try {
    // 2️⃣ 代理认证
    if (PROXY_SERVER) {
      const { username, password } = new URL(PROXY_SERVER);
      if (username && password) await page.authenticate({ username, password });
    }

    // 3️⃣ 登录 & 进入续费界面
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' });
    await page.type('#memberid', EMAIL);
    await page.type('#user_password', PASSWORD);
    await page.click('text=ログインする');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    await page.click('a[href^="/xapanel/xvps/server/detail?id="]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.click('text=更新する');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.click('text=引き続き無料VPSの利用を継続する');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 4️⃣ 图形验证码
    const body = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body })
                     .then(r => r.text());
    await page.type('[placeholder="上の画像の数字を入力"]', code);

    // 5️⃣ Turnstile 验证
    const fh = await page.$('iframe[src*="turnstile"]');
    if (fh) {
      const frame = await fh.contentFrame();
      const src = await fh.evaluate(el => el.src);
      const key = (src.match(/sitekey=([^&]+)/) || [])[1];
      const { data: token } = await solver.turnstile({ pageurl: page.url(), sitekey: key });

      // 注入并触发
      await page.evaluate(t => {
        if (window.turnstile?.onSuccess) window.turnstile.onSuccess(t);
        else {
          let i = document.querySelector('input[name="cf-turnstile-response"]');
          if (!i) {
            i = document.createElement('input');
            i.type = 'hidden';
            i.name = 'cf-turnstile-response';
            document.forms[0].appendChild(i);
          }
          i.value = t;
          document.forms[0].dispatchEvent(new Event('submit', { bubbles: true }));
        }
      }, token);

      await frame.click('input[type="checkbox"]');
      await page.waitForSelector('#success[style*="display: flex"]', { timeout: 30000 });
    }

    // 6️⃣ 点击最终续费
    await page.click('text=無料VPSの利用を継続する');

  } catch (e) {
    console.error(e);
    await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
  }
})();
