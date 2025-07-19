import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import TwoCaptcha from '2captcha';

// 环境变量
const {
  EMAIL,
  PASSWORD,
  TWOCAPTCHA_KEY,      // 在 GH Secrets 中配置
  PROXY_SERVER         // 如不需要可留空
} = process.env;

// 初始化 2Captcha
const solver = new TwoCaptcha.Solver(TWOCAPTCHA_KEY);

(async () => {
  // Puppeteer 启动参数
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY_SERVER) {
    const proxy = new URL(PROXY_SERVER);
    proxy.username = '';
    proxy.password = '';
    args.push(`--proxy-server=${proxy}`.replace(/\/$/, ''));
  }

  const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
  });
  const [page] = await browser.pages();

  // 取消导航超时
  page.setDefaultNavigationTimeout(0);

  // 去掉 “Headless” 字样
  const ua = await browser.userAgent();
  await page.setUserAgent(ua.replace('Headless', ''));

  // 原生录屏占位（如需真的录屏请换成 puppeteer-screen-recorder）
  const recorder = await page.screencast({ path: 'recording.webm' });

  try {
    // 代理认证
    if (PROXY_SERVER) {
      const { username, password } = new URL(PROXY_SERVER);
      if (username && password) {
        await page.authenticate({ username, password });
      }
    }

    // 1. 登录
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' });
    await page.type('#memberid', EMAIL);
    await page.type('#user_password', PASSWORD);
    await page.click('text=ログインする');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 2. 进入续费页面
    await page.click('a[href^="/xapanel/xvps/server/detail?id="]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.click('text=更新する');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 3. 图形验证码
    const imgData = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch(
      'https://captcha-120546510085.asia-northeast1.run.app',
      { method: 'POST', body: imgData }
    ).then(r => r.text());
    console.log('图形验证码识别：', code);
    await page.type('[placeholder="上の画像の数字を入力"]', code);

    // 4. Turnstile 自动验证
    const frameHandle = await page.$('iframe[src*="turnstile"]');
    if (frameHandle) {
      console.log('检测到 Turnstile，开始自动验证...');
      const frame = await frameHandle.contentFrame();
      if (!frame) throw new Error('无法获取 Turnstile iframe');

      // 提取 sitekey
      const src = await frameHandle.evaluate(el => el.src);
      const sitekeyMatch = src.match(/sitekey=([^&]+)/);
      if (!sitekeyMatch) throw new Error('sitekey 提取失败');
      const sitekey = sitekeyMatch[1];

      // 请求 2Captcha
      const turnRes = await solver.turnstile({ pageurl: page.url(), sitekey });
      const token = turnRes.data;
      console.log('2Captcha Turnstile token:', token);

      // 注入 token 并触发回调
      await page.evaluate(t => {
        if (window.turnstile?.onSuccess) {
          window.turnstile.onSuccess(t);
        } else {
          let inp = document.querySelector('input[name="cf-turnstile-response"]');
          if (!inp) {
            inp = document.createElement('input');
            inp.type = 'hidden';
            inp.name = 'cf-turnstile-response';
            document.forms[0].appendChild(inp);
          }
          inp.value = t;
          document.forms[0].dispatchEvent(new Event('submit', { bubbles: true }));
        }
      }, token);

      // 在 iframe 内点击一下复选框，刷新 UI
      await frame.click('input[type="checkbox"]');
      await page.waitForSelector('#success[style*="display: flex"]', { timeout: 30000 });
      console.log('Turnstile 验证成功');
    } else {
      console.log('未检测到 Turnstile iframe，跳过验证');
    }

    // 5. 点击续费按钮
    await page.click('text=無料VPSの利用を継続する');

    // 6. 等待续费成功提示
    await page.waitForSelector('text=申し込みを受け付けました', { timeout: 30000 });
    console.log('续费已受理 ✔️');
  } catch (err) {
    console.error('脚本出错:', err);
    await page.screenshot({ path: 'error-screenshot.png' });
    process.exit(1);
  } finally {
    await setTimeout(5000);
    await recorder.stop();
    await browser.close();
  }
})();
