import puppeteer from 'puppeteer';
import process from 'node:process';
import fs from 'node:fs/promises';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'renewal.log' }),
  ],
});

const { EMAIL, PASSWORD, SENDKEY } = process.env;

if (!EMAIL || !PASSWORD || !SENDKEY) {
  throw new Error('环境变量 EMAIL, PASSWORD 或 SCKEY_SENDKEY 未设置');
}

const CONFIG = {
  LOGIN_URL: 'https://www.xserver.ne.jp/login_member.php',
  SERVER_URL: 'https://www.xserver.ne.jp/login_server.php',
  CONTINUE_BUTTON_TEXT: '無料VPSの利用を継続する',
};

const notify = async (title, desp) => {
  try {
    const response = await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp }),
    });
    if (!response.ok) throw new Error(`通知发送失败: ${response.status}`);
    logger.info('通知发送成功');
  } catch (err) {
    logger.error('通知发送失败:', err);
  }
};

const browser = await puppeteer.launch({
  defaultViewport: { width: 1080, height: 1024 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const [page] = await browser.pages();
  logger.info(`导航到 ${CONFIG.LOGIN_URL}`);
  await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  await page.locator('#memberid, [name="memberid"]').fill(EMAIL);
  await page.locator('#password, [name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  logger.info(`导航到 ${CONFIG.SERVER_URL}`);
  await page.goto(CONFIG.SERVER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.locator(`a[href*="vps"]:has-text("サーバー管理")`).click();
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  await page.locator(`a:has-text("${CONFIG.CONTINUE_BUTTON_TEXT}")`).click();
  await page.waitForSelector('form[action*="continue"]', { timeout: 30000 });

  const maxCaptchaTries = 3;
  let solved = false;

  for (let attempt = 1; attempt <= maxCaptchaTries; attempt++) {
    const captchaImg = await page.$('img[src^="data:"]');
    if (!captchaImg) {
      logger.info('无验证码，跳过验证码填写');
      await fs.writeFile('no_captcha.html', await page.content());
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
      logger.warn(`验证码识别接口失败 (第 ${attempt} 次):`, err);
      await fs.writeFile(`captcha_failed_${attempt}.png`, await captchaImg.screenshot());
      continue;
    }

    if (!code || code.length < 4) {
      logger.warn(`验证码识别失败 (第 ${attempt} 次)`);
      continue;
    }

    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);
    const [nav] = await Promise.allSettled([
      page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }),
      page.locator(`text=${CONFIG.CONTINUE_BUTTON_TEXT}`).click(),
    ]);

    if (nav.status === 'fulfilled') {
      logger.info(`验证码尝试成功 (第 ${attempt} 次)`);
      solved = true;
      break;
    }

    logger.warn(`验证码尝试失败 (第 ${attempt} 次)，刷新重试...`);
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  }

  if (!solved) {
    throw new Error('验证码识别失败：尝试多次未成功');
  }

  await notify('Xserver VPS 续期成功', `✅ 成功续期 ${new Date().toLocaleString('ja-JP')}`);
} catch (err) {
  logger.error('续期失败:', err);
  await notify('Xserver VPS 续期失败 ❌', `${err}`);
} finally {
  await page.screenshot({ path: 'final_state.png' });
  await browser.close();
}
