// 浏览器辅助登录: 主页面先加载 picwish.cn(带登录处理 JS),再弹窗打开 QQ 扫码页,复刻真实登录流程
// 用法: node browser-login.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TOKEN_KEY = 'passport_api_token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  // 1. 向 passport 申请 QQ 扫码登录地址(带回调)
  const qrReq = await fetch(
    'https://aw.aoscdn.com/base/passport/v2/oauth/qrcode?product_id=482&provider=qq&client_id=102013099&callback=' + encodeURIComponent('https://picwish.cn/'),
    { headers: { 'User-Agent': UA } }
  );
  const qrData = await qrReq.json();
  if (qrData.status !== 200 || !qrData.data || !qrData.data.url) {
    throw new Error('申请 QQ 登录失败: ' + JSON.stringify(qrData));
  }
  console.log('[1] 拿到 QQ 登录地址:', qrData.data.url);

  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const page = await browser.newPage();
  console.log('[2] 打开 picwish.cn 主页面...');
  await page.goto('https://picwish.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000); // 等站点 JS 就绪(opener 消息监听)

  console.log('[3] 弹出 QQ 扫码登录窗口...');
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 30000 }),
    page.evaluate((url) => window.open(url, '_blank'), qrData.data.url),
  ]);
  console.log('[3] 请用手机 QQ 扫描弹出窗口中的二维码并确认登录');
  console.log('[3] 登录成功后脚本自动提取 token(最多等 6 分钟)...');

  const deadline = Date.now() + 6 * 60 * 1000;
  let lastUrl = '';
  let stuckAt = 0;
  while (Date.now() < deadline) {
    const curUrl = page.url();
    if (curUrl !== lastUrl) {
      console.log('[3] 主页面跳转:', curUrl);
      lastUrl = curUrl;
    }
    if (popup && !popup.isClosed()) {
      const pUrl = popup.url();
      if (pUrl !== lastUrl) { /* 弹窗跳转打印在下面 */ }
      if (pUrl.includes('gw.aoscdn.com')) {
        if (stuckAt === 0) stuckAt = Date.now();
        if (Date.now() - stuckAt > 15000) {
          // 弹窗卡在回调页,打印现场
          console.log('[!] 弹窗卡在回调页,URL:', pUrl);
          try {
            const body = await popup.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '');
            console.log('[!] 弹窗内容:', body);
          } catch (e) { console.log('[!] 弹窗内容读取失败:', e.message); }
          stuckAt = 0;
        }
      } else {
        stuckAt = 0;
      }
    }
    const token = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY).catch(() => null);
    if (token) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg.accountToken = token;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
      const info = await page.evaluate(() => localStorage.getItem('passport_user_info')).catch(() => null);
      console.log('[4] 登录成功!token 已写入 config.json 的 accountToken');
      console.log('[4] token:', token.slice(0, 24) + '...');
      if (info) {
        try {
          const u = JSON.parse(info);
          console.log('[4] 账号信息:', u.nickname || u.user_name || u.telephone || u.email || JSON.stringify(u).slice(0, 120));
        } catch (e) {}
      }
      console.log('[4] 重启服务生效: node server.js');
      await browser.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('超时未检测到登录,请重试');
  await browser.close();
  process.exit(1);
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
