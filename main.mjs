import puppeteer from 'puppeteer';
import fetch from 'node-fetch';
import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const {
  EMAIL,
  PASSWORD,
  SCKEY_TURBO,
  GITHUB_RUN_URL,      // GitHub 会注入
  GITHUB_RUN_ID,
  GITHUB_SERVER_URL,
  GITHUB_REPOSITORY
} = process.env;

const baseUrl = 'https://secure.xserver.ne.jp';

async function pushServerchan(txt) {
  if (!SCKEY_TURBO) return;
  const url = `https://sctapi.ftqq.com/${SCKEY_TURBO}.send`;
  try {
    await fetch(url, {
      method: 'POST',
      body: new URLSearchParams({
        title: 'Xserver VPS 续期脚本',
        desp: txt
      })
    });
  } catch { /* ignore */ }
}

let browser;
let recorder;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1080, height: 1024 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const [page] = await browser.pages();
  recorder = await page.screencast({ path: 'recording.webm' });

  page.setDefaultTimeout(20_000);

  await page.goto(`${baseUrl}/xapanel/login/xserver/`, { waitUntil: 'networkidle2' });
  await page.type('#memberid', EMAIL);
  await page.type('#user_password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.click('input[type=submit]')
  ]);

  await page.goto(`${baseUrl}/xapanel/xvps/index`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.contract__menuIcon');
  await page.click('.contract__menuIcon');
  await page.click('text=契約情報');
  await page.click('text=更新する');
  await page.click('text=引き続き無料VPSの利用を継続する');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  await page.click('text=無料VPSの利用を継続する');

  await delay(3000); // 录多 3 秒结尾画面
  await pushServerchan(`✅ 自动续期成功\n\n[查看运行记录](${GITHUB_RUN_URL})`);
} catch (e) {
  console.error(e);
  if (browser) {
    const [page] = await browser.pages();
    if (page) {
      const buf = await page.screenshot();
      await writeFile('last.png', buf);
    }
  }
  await pushServerchan(`❌ 自动续期失败\n\n${e}\n\n[运行记录](${GITHUB_RUN_URL})`);
} finally {
  await delay(2000);
  if (recorder) await recorder.stop();
  if (browser) await browser.close();
}
