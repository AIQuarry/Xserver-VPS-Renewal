import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import fetch from 'node-fetch';

// 从环境变量读取
const { EMAIL, PASSWORD, TWOCAPTCHA_KEY, PROXY_SERVER } = process.env;

(async () => {
  // Puppeteer 启动参数
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY_SERVER) {
    const proxyUrl = new URL(PROXY_SERVER);
    proxyUrl.username = '';
    proxyUrl.password = '';
    args.push(`--proxy-server=${proxyUrl}`.replace(/\/$/, ''));
  }

  const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
  });
  const [page] = await browser.pages();
  page.setDefaultNavigationTimeout(0);
  await page.setUserAgent((await browser.userAgent()).replace('Headless', ''));
  // 保留原录屏占位
  const recorder = await page.screencast({ path: 'recording.webm' });

  try {
    // 代理认证（如有）
    if (PROXY_SERVER) {
      const { username, password } = new URL(PROXY_SERVER);
      if (username && password) {
        await page.authenticate({ username, password });
      }
    }

    // 登录 & 进入续费页面
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

    // 图形验证码识别
    const imgSrc = await page.$eval('img[src^="data:"]', img => img.src);
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
      method: 'POST',
      body: imgSrc,
    }).then(r => r.text());
    console.log('验证码识别结果：', code);
    await page.type('[placeholder="上の画像の数字を入力"]', code);

    // 增强版 Cloudflare Turnstile 检测与处理
    let cfDetected = false;

    // 方法1: iframe 验证
    try {
      await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { visible: true, timeout: 5000 });
      cfDetected = true;
      console.log('检测到 Cloudflare iframe 验证');
    } catch { /* not found */ }

    // 方法2: 内联复选框
    if (!cfDetected) {
      try {
        await page.waitForSelector('label.cb-lb > input[type="checkbox"]', { visible: true, timeout: 5000 });
        cfDetected = true;
        console.log('检测到内联 "人間であることを確認します" 复选框');
      } catch { /* not found */ }
    }

    // 方法3: 品牌元素
    if (!cfDetected) {
      try {
        await page.waitForSelector('div#branding, a.cf-link', { visible: true, timeout: 5000 });
        cfDetected = true;
        console.log('检测到 Cloudflare 品牌元素');
      } catch { /* not found */ }
    }

    if (cfDetected) {
      console.log('开始解决 Cloudflare 验证…');

      // 尝试提取 sitekey
      let sitekey = null;
      try {
        const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]');
        if (iframe) {
          const src = await iframe.evaluate(el => el.src);
          const m = src.match(/sitekey=([^&]+)/);
          if (m) sitekey = m[1];
        }
      } catch {}

      if (!sitekey) {
        // 尝试从内联脚本提取
        try {
          sitekey = await page.$eval('script', scripts => {
            for (const s of Array.from(document.scripts)) {
              const txt = s.textContent || '';
              const m = txt.match(/sitekey:\s*['"]([^'"]+)['"]/);
              if (m) return m[1];
            }
            return null;
          });
        } catch {}
      }

      if (!sitekey) {
        sitekey = '0x4AAAAAABlb1fIlWBrSDU3B'; // 默认备用
        console.log('使用默认 sitekey:', sitekey);
      } else {
        console.log('提取到 sitekey:', sitekey);
      }

      // 发起 2Captcha 请求
      const submitUrl = `https://2captcha.com/in.php?key=${TWOCAPTCHA_KEY}&method=turnstile&sitekey=${sitekey}&pageurl=${encodeURIComponent(page.url())}`;
      const submitRes = await fetch(submitUrl);
      const submitText = await submitRes.text();
      if (!submitText.startsWith('OK|')) throw new Error('2Captcha 提交失败: ' + submitText);
      const captchaId = submitText.split('|')[1];
      console.log('2Captcha 任务 ID:', captchaId);

      // 轮询获取 token
      let token = null;
      for (let i = 0; i < 20; i++) {
        await setTimeout(5000);
        const res = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_KEY}&action=get&id=${captchaId}`);
        const text = await res.text();
        if (text.startsWith('OK|')) {
          token = text.split('|')[1];
          console.log('获取到 token');
          break;
        }
        if (text !== 'CAPCHA_NOT_READY') throw new Error('2Captcha 错误: ' + text);
        console.log(`等待 token (${i + 1}/20)…`);
      }
      if (!token) throw new Error('获取 token 超时');

      // 注入 token
      await page.evaluate(t => {
        // 尝试注入到 input
        let inp = document.querySelector('input[name="cf-turnstile-response"]');
        if (!inp) {
          inp = document.createElement('input');
          inp.type = 'hidden';
          inp.name = 'cf-turnstile-response';
          document.forms[0].appendChild(inp);
        }
        inp.value = t;
        // 提交表单触发验证
        document.forms[0].dispatchEvent(new Event('submit', { bubbles: true }));
      }, token);

      // 如果是 iframe 版本，点击复选框刷新 UI
      try {
        const frame = await (await page.$('iframe[src*="challenges.cloudflare.com"]')).contentFrame();
        await frame.click('input[type="checkbox"]');
      } catch {}

      // 等待验证成功或复选框消失
      await Promise.race([
        page.waitForSelector('#success[style*="display: flex"]', { visible: true, timeout: 30000 }),
        page.waitForSelector('label.cb-lb > input[type="checkbox"]', { hidden: true, timeout: 30000 }),
      ]);
      console.log('Cloudflare 验证完成');
    } else {
      console.log('未检测到 Cloudflare 验证，跳过');
    }

    // 点击最终续费按钮
    console.log('点击续费按钮…');
    await page.waitForSelector('text=無料VPSの利用を継続する', { visible: true, timeout: 30000 });
    await page.click('text=無料VPSの利用を継続する');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('续费操作完成 ✅');

  } catch (err) {
    console.error('发生错误:', err);
    await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await setTimeout(3000);
    await recorder.stop();
    await browser.close();
  }
})();
