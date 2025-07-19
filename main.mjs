import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import TwoCaptcha from '2captcha';

// 直接用 GH Actions 提供的环境变量
const {
  EMAIL,            // 在 Actions Secrets 中配置
  PASSWORD,         // 在 Actions Secrets 中配置
  TWOCAPTCHA_KEY,   // 在 Actions Secrets 中配置
  PROXY_SERVER      // 如果需要也可在 Secrets/Env 中配置
} = process.env;

// 2Captcha 初始化
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

  // 去掉 Headless 标识
  const ua = await browser.userAgent();
  await page.setUserAgent(ua.replace('Headless', ''));

  // 录屏示例（可选，需安装 puppeteer-screen-recorder）
  // import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';
  // const recorder = new PuppeteerScreenRecorder(page);
  // await recorder.start('recording.webm');
  const recorder = { stop: async () => {} };

  try {
    // 如果代理含用户名/密码
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

    // 2. 跳转到续费操作
    await page.click('a[href^="/xapanel/xvps/server/detail?id="]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.click('text=更新する');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 3. 图像验证码
    const imgData = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
      method: 'POST',
      body: imgData,
    }).then(res => res.text());
    console.log('图像验证码：', code);
    await page.type('[placeholder="上の画像の数字を入力"]', code);

    // 4. Turnstile 自动验证
    const frameHandle = await page.$('iframe[src*="turnstile"]');
    if (frameHandle) {
      console.log('检测到 Turnstile，开始 2Captcha 验证...');
      const frame = await frameHandle.contentFrame();
      if (!frame) throw new Error('无法切换到 Turnstile iframe');
      const src = await frameHandle.evaluate(el => el.src);
      const sitekeyMatch = src.match(/sitekey=([^&]+)/);
      const sitekey = sitekeyMatch?.[1];
      if (!sitekey) throw new Error('解析 sitekey 失败');
      const turnRes = await solver.turnstile({ pageurl: page.url(), sitekey });
      const token = turnRes.data;
      console.log('Turnstile token:', token);

      // 注入并回调
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

      await frame.click('input[type="checkbox"]');
      await page.waitForSelector('#success[style*="display: flex"]', { timeout: 30000 });
      console.log('Turnstile 验证成功');
    }

    // 5. 完成续费
    await page.waitForSelector('text=無料VPSの利用を継続する', { timeout: 20000 });
    await page.click('text=無料VPSの利用を継続する');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    console.log('续费完成！');
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
