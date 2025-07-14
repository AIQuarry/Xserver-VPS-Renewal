import puppeteer from 'puppeteer';
import { setTimeout } from 'node:timers/promises';

// 日志函数，带时间戳和颜色标记
const log = (message, color = '\x1b[36m') => {
    const timestamp = new Date().toISOString();
    console.log(`${color}[${timestamp}] ${message}\x1b[0m`);
};

log('开始执行 Xserver VPS 自动续订脚本', '\x1b[32m');

const browser = await puppeteer.launch({
    headless: true, // 明确设置无头模式
    defaultViewport: { width: 1200, height: 800 }, // 增加视口大小
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--lang=ja-JP' // 设置日语环境
    ],
    timeout: 60000 // 增加浏览器启动超时时间
});

log('浏览器已启动');

try {
    const [page] = await browser.pages();
    log('页面已创建');
    
    // 启动屏幕录制
    const recorder = await page.screencast({ 
        path: 'recording.webm',
        fps: 12, // 降低帧率减少文件大小
        scale: 0.8 // 缩小录制比例
    });
    log('屏幕录制已启动');

    // 设置页面超时和语言
    await page.setDefaultNavigationTimeout(60000);
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'ja-JP'
    });

    // 步骤1: 导航到登录页面
    log('导航到登录页面...');
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', {
        waitUntil: 'networkidle2',
        timeout: 45000
    });
    log('登录页面已加载');

    // 步骤2: 填写登录表单
    log('填写登录信息...');
    await page.locator('#memberid').waitFor({ timeout: 15000 });
    await page.locator('#memberid').fill(process.env.EMAIL);
    await page.locator('#user_password').fill(process.env.PASSWORD);
    log('登录信息已填写');

    // 步骤3: 提交登录表单
    log('提交登录表单...');
    const loginPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.locator('text=ログインする').click();
    await loginPromise;
    log('登录成功');

    // 步骤4: 导航到VPS管理页面
    log('导航到VPS管理页面...');
    await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', {
        waitUntil: 'networkidle2',
        timeout: 45000
    });
    log('VPS管理页面已加载');

    // 步骤5: 打开菜单
    log('打开菜单...');
    await page.locator('.contract__menuIcon').waitFor({ timeout: 15000 });
    await page.locator('.contract__menuIcon').click();
    await setTimeout(800); // 添加短暂延迟让菜单动画完成
    log('菜单已打开');

    // 步骤6: 访问契约信息
    log('访问契约信息...');
    await page.locator('text=契約情報').waitFor({ timeout: 15000 });
    await page.locator('text=契約情報').click();
    await setTimeout(800);
    log('契约信息页面已打开');

    // 步骤7: 点击更新按钮
    log('点击更新按钮...');
    await page.locator('text=更新する').waitFor({ timeout: 15000 });
    await page.locator('text=更新する').click();
    await setTimeout(800);
    log('更新页面已打开');

    // 步骤8: 选择继续免费方案
    log('选择继续免费方案...');
    await page.locator('text=引き続き無料VPSの利用を継続する').waitFor({ timeout: 15000 });
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    
    // 等待确认页面加载
    const confirmPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
    await confirmPromise;
    log('已选择继续免费方案');

    // 步骤9: 确认继续使用
    log('确认继续使用...');
    await page.locator('text=無料VPSの利用を継続する').waitFor({ timeout: 15000 });
    await page.locator('text=無料VPSの利用を継続する').click();
    log('续订请求已提交');

    // 添加额外等待确保操作完成
    await setTimeout(3000);
    log('操作流程已完成', '\x1b[32m');

} catch (error) {
    log(`发生错误: ${error.message}`, '\x1b[31m');
    console.error(error.stack);
    
    // 保存错误截图
    await page.screenshot({ path: 'error.png' });
    log('已保存错误截图: error.png', '\x1b[31m');
    
    throw error; // 重新抛出错误以便GitHub Actions标记失败

} finally {
    log('正在清理资源...');
    
    // 确保屏幕录制正常停止
    if (recorder) {
        await setTimeout(3000); // 确保所有操作都被录制
        await recorder.stop();
        log('屏幕录制已停止');
    }
    
    // 关闭浏览器
    if (browser) {
        await browser.close();
        log('浏览器已关闭');
    }
    
    log('脚本执行完成', '\x1b[32m');
}
