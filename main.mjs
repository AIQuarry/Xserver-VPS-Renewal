import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import { writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { Blob } from 'node:buffer';
import FormData from 'form-data';

const {
  EMAIL,
  PASSWORD,
  SCKEY_SENDKEY,
  GITHUB_RUN_URL,
} = process.env;

// 上传文件到 Server酱 Turbo
async function uploadMedia(filePath, fileName) {
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('media', new Blob([buffer]), fileName);

  const res = await fetch(`https://sctapi.ftqq.com/${SCKEY_SENDKEY}.upload`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  const json = await res.json();
  return json.data?.file_id;
}

// 推送 Server酱 Turbo 消息（带 media）
async function pushServerchanTurbo(title, desp, mediaIds = []) {
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
    console.warn('Server酱Turbo推送失败:', e);
  }
}

const mediaIds = [];

const browser = await puppeteer.launch({
  defaultViewport: { width: 1080, height: 1024 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const [page] = await browser.pages();
const recorder = await page.screencast({ path: 'recording.webm' });

try {
  await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', { waitUntil: 'networkidle2' });
  await page.locator('#memberid').fill(EMAIL);
  await page.locator('#user_password').fill(PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.locator('text=ログインする').click(),
  ]);

  await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' });
  await page.locator('.contract__menuIcon').click();
  await page.locator('text=契約情報').click();
  await page.locator('text=更新する').click();
  await page.locator('text=引き続き無料VPSの利用を継続する').click();
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  await page.locator('text=無料VPSの利用を継続する').click();

  await setTimeout(2000);

  if (fs.existsSync('recording.webm')) {
    mediaIds.push(await uploadMedia('recording.webm', 'recording.webm'));
  }

  await pushServerchanTurbo('✅ Xserver VPS 续期成功',
    `运行成功：[查看记录](${GITHUB_RUN_URL})`,
    mediaIds
  );
} catch (e) {
  console.error(e);
  try {
    const buf = await page.screenshot();
    await writeFile('last.png', buf);
    if (fs.existsSync('last.png')) {
      mediaIds.push(await uploadMedia('last.png', 'last.png'));
    }
  } catch {}

  await pushServerchanTurbo('❌ Xserver VPS 续期失败',
    `${e}\n\n[查看记录](${GITHUB_RUN_URL})`,
    mediaIds
  );
} finally {
  await setTimeout(2000);
  await recorder.stop();
  await browser.close();
}
