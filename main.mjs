import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import { writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { Blob } from 'node:buffer';
import FormData from 'form-data';
import { URL } from 'node:url';

const {
  EMAIL,
  PASSWORD,
  SCKEY_SENDKEY,
  GITHUB_RUN_URL,
  PROXY_SERVER,          // 形如 http://user:pass@host:port
} = process.env;

// ============ Server酱 Turbo 工具函数 ============ //
async function uploadMedia(path, name) {
  const buf = await readFile(path);
  const form = new FormData();
  form.append('media', new Blob([buf]), name);
  const r = await fetch(`https://sctapi.ftqq.com/${SCKEY_SENDKEY}.upload`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  }).then(r => r.json());
  return r.data?.file_id;
}

async function pushTurbo(title, desp, mediaIds = []) {
  if (!SCKEY_SENDKEY) return;
  const body = new URLSearchParams({
    title,
    desp,
    ...(mediaIds.length && { channel: '9', media_id: mediaIds.join(',') }),
  });
  try {
    await fetch(`https://sctapi.ftqq.com/${SCKEY_SENDKEY}.send`, {
      method: 'POST',
      body,
    });
  } catch (e) {
    console.warn('Server酱推送失败:', e);
  }
}
// =============================================== //

const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
if (PROXY_SERVER) {
  const p = new URL(PROXY_SERVER);
  p.username = '';          // 去掉凭据，仅保留 host:port
  p.password = '';
  launchArgs.push(`--proxy-server=${String(p).replace(/\/$/, '')}`);
}

const browser = await puppeteer.launch({
  defaultViewport: { width: 1080, height: 1024 },
  args: launchArgs,
});
const [page] = await browser.pages();
const recorder = await page.screencast({ path: 'recording.webm' });

// 代理需要 407 鉴权
if (PROXY_SERVER) {
  const { username, password } = new URL(PROXY_SERVER);
  if (username && password) await page.authenticate({ username, password });
}

const mediaIds = [];

try {
  // 登录
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' });
  await page.locator('#memberid').fill(EMAIL);
  await page.locator('#user_password').fill(PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.locator('text=ログインする').click(),
  ]);

  // 进入 VPS 详情并续期
  await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click();
  await page.locator('text=更新する').click();
  await page.locator('text=引き続き無料VPSの利用を継続する').click();
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // 处理验证码
  const base64 = await page.$eval('img[src^="data:"]', img => img.src);
  const code = await fetch(
    'https://captcha-120546510085.asia-northeast1.run.app',
    { method: 'POST', body: base64 }
  ).then(r => r.text());
  await page.locator('[placeholder="上の画像の数字を入力"]').fill(code);

  // 最后确认
  await page.locator('text=無料VPSの利用を継続する').click();
  await setTimeout(2000);

  // 录屏上传
  if (fs.existsSync('recording.webm')) {
    mediaIds.push(await uploadMedia('recording.webm', 'recording.webm'));
  }
  await pushTurbo('✅ Xserver VPS 续期成功', `[查看记录](${GITHUB_RUN_URL})`, mediaIds);
} catch (e) {
  console.error(e);
  try {
    const buf = await page.screenshot();
    await writeFile('last.png', buf);
    if (fs.existsSync('last.png')) {
      mediaIds.push(await uploadMedia('last.png', 'last.png'));
    }
  } catch {}
  await pushTurbo('❌ Xserver VPS 续期失败', `${e}\n\n[记录](${GITHUB_RUN_URL})`, mediaIds);
} finally {
  await setTimeout(1500);
  await recorder.stop();
  await browser.close();
}
