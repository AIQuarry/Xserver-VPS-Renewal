import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';

// 日志函数（带颜色与时间戳）
const log = (msg, color = '\x1b[36m') => {
  const time = new Date().toISOString();
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

(async () => {
  log('开始执行 Xserver VPS 自动续订脚本', '\x1b[32m');

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1200, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=ja-JP'
    ],
    timeout: 60000
  });

  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP' });
    await page.setDefaultNavigationTimeout(60000);

    // 登录页面
    log('导航到登录页面...');
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    log('填写登录表单...');
    await page.waitForSelector('#memberid', { timeout: 15000 });
    await page.type('#memberid', process.env.EMAIL);
    await page.type('#user_password', process.env.PASSWORD);

    log('提交登录...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('input[type="submit"]')
    ]);

    // 进入VPS管理
    log('导航到 VPS 管理页面...');
    await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', {
      waitUntil: 'networkidle2'
    });

    // 打开菜单
    log('打开菜单...');
    await page.waitForSelector('.contract__menuIcon', { timeout: 15000 });
    await page.click('.contract__menuIcon');
    await setTimeout(1000);

    // 访问契约信息
    log('访问契约信息...');
    await page.click('text=契約情報');
    await setTimeout(1000);

    // 点击“更新する”
    log('点击更新按钮...');
    await page.click('text=更新する');
    await setTimeout(1000);

    // 选择继续免费
    log('选择继续免费方案...');
    await page.click('text=引き続き無料VPSの利用を継続する');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 最终确认
    log('确认继续使用...');
    await page.click('text=無料VPSの利用を継続する');

    log('✅ VPS续订成功！', '\x1b[32m');
  } catch (err) {
    log(`❌ 出现错误: ${err.message}`, '\x1b[31m');
    await page.screenshot({ path: 'error.png' });
    log('已保存错误截图 error.png');
    process.exit(1); // 标记运行失败
  } finally {
    await browser.close();
    log('浏览器已关闭');
  }
})();
