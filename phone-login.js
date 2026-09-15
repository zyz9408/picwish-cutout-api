// 佐糖手机号验证码登录: 自动走验证码 -> 发短信 -> 换 api_token 写入 config.json
// 用法:
//   node phone-login.js send <手机号>          弹浏览器过验证码并发送短信
//   node phone-login.js verify <手机号> <验证码>  用收到的验证码登录,写 token 到 config.json
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://aw.aoscdn.com/base/passport/v2';
const PRODUCT_ID = '482';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CAPTCHA_JS = 'https://turing.captcha.qcloud.com/TJCaptcha.js';
const INSENS_APPID = '199339633';
const PUZZLE_APPID = '191576650';

async function getTicket(appid) {
  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const page = await browser.newPage();
  console.log('[验证码] 打开 picwish.cn...');
  await page.goto('https://picwish.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.addScriptTag({ url: CAPTCHA_JS }).catch(() => {});
  const run = (id) => page.evaluate(({ appid: id }) => new Promise((resolve) => {
    const go = () => {
      const TC = window.TencentCaptcha;
      if (!TC || typeof TC !== 'function') return setTimeout(go, 300);
      new TC(id, (res) => resolve(res), { bizState: window.location.href, loading: true, needFeedBack: false }).show();
    };
    go();
  }), { appid: id });
  const label = appid === INSENS_APPID ? '无感' : '滑块';
  console.log(`[验证码] ${label}验证中...`);
  const res = await run(appid);
  console.log(`[验证码] ${label}结果: ret=${res && res.ret} keys=${res ? Object.keys(res).join(',') : 'null'}`);
  await browser.close();
  if (!res || res.ret !== 0 || !res.ticket) throw new Error('验证码未通过: ' + JSON.stringify(res));
  return res;
}

async function sendSms(phone, ticket) {
  const r = await passportPost('/captchas', { scene: 'login', telephone: phone }, {
    'X-CAPTCHA': JSON.stringify(ticket),
  });
  console.log('[发送] 响应:', JSON.stringify(r.data));
  return r.data;
}

async function passportPost(endpoint, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${endpoint}?product_id=${PRODUCT_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://picwish.cn',
      Referer: 'https://picwish.cn/',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function main() {
  const [cmd, phone, code] = process.argv.slice(2);
  if (!/^1\d{10}$/.test(phone || '')) {
    console.log('用法: node phone-login.js send <手机号>  或  node phone-login.js verify <手机号> <验证码>');
    process.exit(1);
  }
  if (cmd === 'send') {
    // 先用无感票据试,被服务器拒绝(11317)则换滑块,与佐糖前端行为一致
    let ticket = await getTicket(INSENS_APPID);
    let r = await sendSms(phone, ticket);
    if (r && r.status === 11317) {
      console.log('[发送] 无感票据被拒,改走滑块验证码...');
      ticket = await getTicket(PUZZLE_APPID);
      r = await sendSms(phone, ticket);
    }
    if (r && (r.status === 200 || r.status === 11020)) {
      console.log('[发送] 短信已发送,收到后执行: node phone-login.js verify ' + phone + ' <验证码>');
    } else {
      process.exit(1);
    }
  } else if (cmd === 'verify') {
    if (!/^\d{4,8}$/.test(code || '')) {
      console.log('验证码格式不对');
      process.exit(1);
    }
    console.log('[登录] 手机号 ' + phone + ' 验证码 ' + code + ' ...');
    const r = await passportPost('/login/telephone', { telephone: phone, captcha: code });
    console.log('[登录] 响应:', JSON.stringify(r.data).slice(0, 400));
    const token = r.data && r.data.data && r.data.data.api_token;
    if (!token) {
      console.error('[登录] 未拿到 api_token');
      process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg.accountToken = token;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log('[登录] 成功!token 已写入 config.json 的 accountToken');
    console.log('[登录] 重启服务生效: node server.js');
  } else {
    console.log('未知命令: ' + cmd);
    process.exit(1);
  }
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
