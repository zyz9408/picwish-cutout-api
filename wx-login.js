// 佐糖微信扫码登录: 生成二维码 -> 等待用户扫码 -> 换取 api_token 写入 config.json
// 用法: node wx-login.js [product_id]  (默认 482 网页版)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PRODUCT_ID = process.argv[2] || '482';
const CLIENT_ID = 'wxd6d7038d8f2449ea';
const QR_PATH = path.join(__dirname, 'wechat-qr.png');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 向 passport 服务申请扫码登录
  console.log('[1/4] 申请微信扫码登录...');
  const qrReq = await fetch(
    `https://aw.aoscdn.com/base/passport/v2/oauth/qrcode?product_id=${PRODUCT_ID}&provider=wechat&client_id=${CLIENT_ID}`,
    { headers: { 'User-Agent': UA } }
  );
  const qrData = await qrReq.json();
  if (qrData.status !== 200) throw new Error(`申请失败: ${JSON.stringify(qrData)}`);
  const qrConnectUrl = qrData.data.url;
  console.log('[1/4] 拿到 qrconnect 地址');

  // 2. 访问微信 qrconnect 页面,提取 uuid 和二维码图
  const page = await fetch(qrConnectUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const html = await page.text();
  const uuidM = html.match(/uuid\s*=\s*["']([^"']+)["']/i);
  if (!uuidM) throw new Error('二维码页未找到 uuid: ' + html.slice(0, 200));
  const uuid = uuidM[1];
  console.log('[2/4] 会话 uuid:', uuid);

  const cookies = (page.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/).map((c) => c.split(';')[0]).join('; ');
  const imgRes = await fetch(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
    headers: { 'User-Agent': UA, Cookie: cookies },
  });
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(QR_PATH, imgBuf);
  console.log('[2/4] 二维码已保存:', QR_PATH, `(${imgBuf.length} 字节)`);

  // 弹出二维码图片(Windows 默认图片查看器)
  spawn('cmd', ['/c', 'start', '', QR_PATH], { shell: false });

  // 3. 轮询扫码状态(最长 5 分钟)
  console.log('[3/4] 等待扫码(5分钟内有效)...');
  const deadline = Date.now() + 5 * 60 * 1000;
  let redirectUri = null;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const poll = await fetch(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}&_=${Date.now()}`, {
        headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/connect/qrconnect' },
      });
      const t = await poll.text();
      const rm = t.match(/window\.redirect_uri="([^"]+)"/);
      if (rm) { redirectUri = rm[1].replace(/\\u0026/g, '&'); break; }
      if (t.includes('wx_errcode=405') || t.includes('errcode=405')) {
        const s = '已扫码,请在手机上点击确认';
        if (s !== lastStatus) { console.log('[3/4]', s); lastStatus = s; }
      } else if (t.includes('wx_errcode=404') || t.includes('errcode=404')) {
        throw new Error('二维码已过期,请重新运行本脚本');
      }
    } catch (e) { if (e.message.includes('过期')) throw e; }
    await sleep(2000);
  }
  if (!redirectUri) throw new Error('扫码超时(5分钟),请重新运行本脚本');
  console.log('[3/4] 扫码确认成功!');

  // 4. 跟随 passport 回调,提取 api_token
  console.log('[4/4] 换取登录凭证...');
  let url = redirectUri;
  for (let hop = 0; hop < 6; hop++) {
    console.log('[4/4] 请求:', url.slice(0, 110));
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const loc = res.headers.get('location');
    const body = await res.text();
    // 响应体里直接带 token?
    const tokM = body.match(/"api_token"\s*:\s*"([^"]+)"/) || body.match(/api_token=([a-zA-Z0-9._-]+)/);
    if (tokM) {
      const token = tokM[1];
      console.log('[4/4] 拿到 api_token:', token.slice(0, 24) + '...');
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg.accountToken = token;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
      console.log('[4/4] 已写入 config.json 的 accountToken,重启服务即生效');
      console.log('[4/4] 重启命令: node server.js');
      return;
    }
    if (loc) { url = new URL(loc, url).href; continue; }
    // 无 token 无跳转,打印现场
    console.log('[4/4] 响应体片段:', body.slice(0, 400));
    throw new Error('未能从回调中提取 api_token');
  }
  throw new Error('回调跳转次数过多');
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
