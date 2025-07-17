// main.mjs
import puppeteer from 'puppeteer';
import process from 'node:process';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const SENDKEY = process.env.SCKEY_SENDKEY;

const browser = await puppeteer.launch({
  defaultViewport: { width: 1080, height: 1024 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const [page] = await browser.pages();

try {
  await page.goto('https://www.xserver.ne.jp/login_member.php', { waitUntil: 'networkidle2' });
  await page.locator('#memberid').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  await page.goto('https://www.xserver.ne.jp/login_server.php', { waitUntil: 'networkidle2' });
  await page.locator('a[href*="vps"]:has-text("サーバー管理")').click();
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  await page.locator('a:has-text("無料VPSの利用を継続する")').click();
  await page.waitForSelector('form[action*="continue"]');

  const maxCaptchaTries = 3;
  let solved = false;

  for (let attempt = 1; attempt <= maxCaptchaTries; attempt++) {
    const captchaImg = await page.$('img[src^="data:"]');

    if (!captchaImg) {
      console.log('无验证码，跳过验证码填写');
      solved = true;
      break;
    }

    const base64 = await captchaImg.evaluate(img => img.src);
    let code = '';
    try {
      code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body: base64,
      }).then(r => r.text());
    } catch (err) {
      console.warn('验证码识别接口调用失败:', err);
    }

    if (!code || code.length < 4) {
      console.log(`验证码识别失败（第 ${attempt} 次）`);
      continue;
    }

    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);

    const [nav] = await Promise.allSettled([
      page.waitForNavigation({ timeout: 10000, waitUntil: 'networkidle2' }),
      page.locator('text=無料VPSの利用を継続する').click(),
    ]);

    if (nav.status === 'fulfilled') {
      console.log(`验证码尝试成功（第 ${attempt} 次）`);
      solved = true;
      break;
    }

    console.warn(`验证码尝试失败（第 ${attempt} 次），刷新验证码重试...`);
    await page.reload({ waitUntil: 'networkidle2' });
  }

  if (!solved) {
    throw new Error('验证码识别失败：尝试多次未成功');
  }

  // 成功推送通知
  await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      title: 'Xserver VPS 续期成功',
      desp: `✅ 成功续期 ${new Date().toLocaleString('ja-JP')}`,
    }),
  });

  console.log('续期成功，已推送通知');
} catch (err) {
  console.error('出错:', err);

  await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      title: 'Xserver VPS 续期失败 ❌',
      desp: `${err}`,
    }),
  });
} finally {
  await browser.close();
}
