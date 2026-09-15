// 获取腾讯防水墙验证码票据(无感优先,失败降级滑块,窗口可见可手动拖)
// 用法: node captcha-ticket.js
'use strict';
const { chromium } = require('playwright-core');

const CAPTCHA_JS = 'https://turing.captcha.qcloud.com/TJCaptcha.js';
const INSENS_APPID = '199339633'; // 无感验证
const PUZZLE_APPID = '191576650'; // 滑块验证

function loadCaptcha(page, appid) {
  return page.evaluate(({ appid }) => new Promise((resolve) => {
    const run = () => {
      const TC = window.TencentCaptcha;
      if (!TC || typeof TC !== 'function') return setTimeout(run, 300);
      new TC(appid, (res) => resolve(res), {
        bizState: window.location.href,
        loading: true,
        needFeedBack: false,
      }).show();
    };
    run();
  }), { appid });
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const page = await browser.newPage();
  console.log('[1] 打开 picwish.cn...');
  await page.goto('https://picwish.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.addScriptTag({ url: CAPTCHA_JS }).catch(() => {});
  console.log('[2] 无感验证中(几秒)...');
  let res = await loadCaptcha(page, INSENS_APPID);
  console.log('[2] 无感结果:', JSON.stringify(res));
  if (!res || res.ret !== 0) {
    console.log('[3] 降级滑块验证,请在弹出的浏览器窗口里拖动滑块...');
    res = await loadCaptcha(page, PUZZLE_APPID);
    console.log('[3] 滑块结果:', JSON.stringify(res));
  }
  if (res && res.ret === 0 && res.ticket) {
    console.log('TICKET_JSON=' + JSON.stringify(res));
  } else {
    console.error('验证码未通过:', JSON.stringify(res));
    process.exitCode = 1;
  }
  await browser.close();
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
