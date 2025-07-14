import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const {
  EMAIL,
  PASSWORD,
  SCKEY_SENDKEY,
  GITHUB_RUN_URL,
} = process.env;

async function pushServerchanTurbo(text) {
  if (!SCKEY_SENDKEY) return;
  try {
    await fetch(`https://sctapi.ftqq.com/${SCKEY_SENDKEY}.send`, {
      method: 'POST',
      body: new URLSearchParams({
        title: 'Xserver VPS续期脚本',
        desp: text,
      }),
    });
  } catch (e) {
    console.warn('Server酱Turbo推送失败:', e);
  }
}

(async () => {
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

    await setTimeout(3000);

    await pushServerchanTurbo(`✅ VPS续期成功！\n\n[查看运行记录](${GITHUB_RUN_URL})`);
  } catch (e) {
    console.error(e);
    try {
      const buf = await page.screenshot();
      await writeFile('last.png', buf);
    } catch {}
    await pushServerchanTurbo(`❌ VPS续期失败！\n\n${e}\n\n[查看运行记录](${GITHUB_RUN_URL})`);
  } finally {
    await setTimeout(2000);
    await recorder.stop();
    await browser.close();
  }
})();
