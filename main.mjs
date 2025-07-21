import puppeteer from 'puppeteer';
import { setTimeout as delay } from 'node:timers/promises';

// --- 2Captcha 設定 ---
// 環境変数からAPIキーを読み込みます。
// 事前に `export TWOCAPTCHA_API_KEY='YOUR_API_KEY'` のように設定してください。
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/**
 * 2Captcha APIに解決済みの結果を問い合わせるポーリング関数
 * @param {string} captchaId - /in.php から受け取った验证码タスクID
 * @returns {Promise<string>} - 解決済みのトークン
 */
async function pollFor2CaptchaResult(captchaId) {
    console.log(`2Captchaにタスクを送信しました。ID: ${captchaId}。サーバーの処理を待っています...`);
    
    // サーバーがタスクを受け付けるための初期待機時間
    await delay(20000); 

    while (true) {
        try {
            const resultResponse = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`);
            const result = await resultResponse.json();

            if (result.status === 1) {
                // 成功
                console.log(`解決に成功しました！ トークン: ${result.request.substring(0, 30)}...`);
                return result.request;
            }

            if (result.request !== 'CAPCHA_NOT_READY') {
                // 「準備中」以外のエラーが発生した場合
                throw new Error(`2Captchaでの解決中にエラーが発生しました: ${result.request}`);
            }

            // まだ準備ができていない場合
            console.log('まだ解決が完了していません。10秒後に再試行します...');
            await delay(10000); // 10秒ごとに再確認
        } catch (error) {
            console.error("2Captchaの結果取得中にネットワークエラーが発生しました:", error);
            // エラー発生時も待機してリトライ
            await delay(10000);
        }
    }
}

/**
 * 2Captchaを使用してCloudflare Turnstileを解決します
 * @param {string} sitekey - ページのHTMLから取得した `data-sitekey` の値
 * @param {string} pageUrl - Turnstileが表示されているページの完全なURL
 * @returns {Promise<string>} - 解決済みのTurnstileトークン
 */
async function solveTurnstile(sitekey, pageUrl) {
    console.log('2CaptchaにTurnstileの解決をリクエストします...');
    const sendResponse = await fetch('https://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            key: TWOCAPTCHA_API_KEY,
            method: 'turnstile',
            sitekey: sitekey,
            pageurl: pageUrl,
            json: 1 // JSON形式でレスポンスを受け取る
        })
    });
    const sendResult = await sendResponse.json();
    if (sendResult.status !== 1) {
        throw new Error(`2Captchaへのリクエスト送信に失敗しました: ${sendResult.request}`);
    }

    // ポーリング関数を呼び出して結果を待つ
    return pollFor2CaptchaResult(sendResult.request);
}

/**
 * メインの実行関数
 */
async function main() {
    // APIキーの存在チェック
    if (!TWOCAPTCHA_API_KEY) {
        console.error('エラー: 環境変数 TWOCAPTCHA_API_KEY が設定されていません。');
        process.exit(1);
    }

    // コマンドライン引数からURLを取得
    const targetUrl = process.argv[2];
    if (!targetUrl) {
        console.error('エラー: 解決対象のURLをコマンドライン引数として指定してください。');
        console.log('使用法: node solve_turnstile.js "https://example.com/login"');
        process.exit(1);
    }

    console.log(`ブラウザを起動しています...`);
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    try {
        console.log(`指定されたURLに移動します: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        console.log('Cloudflare Turnstileの要素を探しています...');
        // Turnstileのdiv要素が表示されるまで最大30秒待機
        const turnstileElement = await page.waitForSelector('div.cf-turnstile', { timeout: 30000 });

        if (!turnstileElement) {
            throw new Error('このページでCloudflare Turnstileが見つかりませんでした。');
        }
        
        console.log('Turnstileを発見しました。sitekeyを取得します。');
        const sitekey = await turnstileElement.evaluate(el => el.getAttribute('data-sitekey'));
        if (!sitekey) {
            throw new Error('data-sitekey属性の取得に失敗しました。');
        }
        console.log(`Sitekey: ${sitekey}`);

        // 2CaptchaでTurnstileを解決
        const token = await solveTurnstile(sitekey, targetUrl);

        console.log('取得したトークンをページに挿入します...');
        // ページ内のJavaScriptコンテキストで実行
        await page.evaluate((tokenValue) => {
            // Turnstileが生成するレスポンス用の隠し要素を探す
            const responseElement = document.querySelector('[name="cf-turnstile-response"]');
            if (responseElement) {
                responseElement.value = tokenValue;
            }

            // data-callbackで指定されたコールバック関数を実行する
            const callbackName = document.querySelector('.cf-turnstile')?.dataset.callback;
            if (callbackName && typeof window[callbackName] === 'function') {
                console.log(`コールバック関数 '${callbackName}' を実行します。`);
                window[callbackName](tokenValue);
            }
        }, token);

        console.log('Turnstileの解決とトークンの挿入が完了しました。');
        console.log('この後、フォームの送信ボタンをクリックするなどの操作を続けることができます。');
        
        // 例: 5秒待機して、手動で確認できるようにする
        await delay(5000);
        
        // ここにフォームの送信処理などを追加できます
        // await page.click('#submit-button');

        await page.screenshot({ path: 'turnstile_solved.png' });
        console.log('完了後のスクリーンショットを `turnstile_solved.png` として保存しました。');

    } catch (e) {
        console.error('スクリプトの実行中にエラーが発生しました:', e);
        await page.screenshot({ path: 'error.png' });
        console.log('エラー発生時のスクリーンショットを `error.png` として保存しました。');
    } finally {
        console.log('ブラウザを閉じます。');
        await browser.close();
    }
}

// スクリプトを実行
main();
