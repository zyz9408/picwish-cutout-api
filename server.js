// 佐糖(PicWish) 抠图 API 反代服务 — 零依赖,Node 18+
// 流程: 客户端上传图片 -> 本服务代传 gw.aoscdn.com(用你的会话 token 或游客 token)
//       -> 轮询抠图任务 -> 返回无水印 PNG
// 启动: node server.js    (配置见 config.json)

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  host: '127.0.0.1',   // 默认仅本机监听,公网访问交给 Nginx 反代
  port: 8787,          // 服务端口
  apiKey: '',          // 访问密钥,留空则任何人可访问;设置后客户端需带 x-api-key 头
  accountToken: '',    // 佐糖账号 token(Bearer),留空则用游客模式
  productId: 482,      // 产品 ID,网页版 482,桌面客户端 492
  language: 'en',      // 请求语言参数(官方流程为 en)
  hd: true,            // 是否走 image-url 接口取无水印高清图
  picQuality: 'free',  // image-url 接口的 pic_quality 参数
  maxSizeMB: 15,       // 上传大小上限(MB)
  timeoutSec: 120,     // 单个任务总超时(秒)
  pollMs: 800,         // 轮询间隔(毫秒)
};
const config = { ...DEFAULT_CONFIG };
if (fs.existsSync(CONFIG_PATH)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch (e) { console.warn('[warn] config.json 解析失败,使用默认配置:', e.message); }
}
for (const [k, env] of Object.entries({
  host: 'CUTOUT_HOST', port: 'CUTOUT_PORT', apiKey: 'CUTOUT_API_KEY', accountToken: 'CUTOUT_ACCOUNT_TOKEN',
  productId: 'CUTOUT_PRODUCT_ID', language: 'CUTOUT_LANGUAGE', picQuality: 'CUTOUT_PIC_QUALITY',
})) {
  if (process.env[env] !== undefined) config[k] = env === 'port' || env === 'CUTOUT_PRODUCT_ID'
    ? Number(process.env[env]) : process.env[env];
}

const GW = 'https://gw.aoscdn.com/app/picwish';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API_OK = new Set([0, 200]);
const MAX_SIZE = config.maxSizeMB * 1024 * 1024;

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function guestToken(pid) {
  const rand = String(Math.floor(10000000 + Math.random() * 90000000));
  return `v2,${rand},${pid},${crypto.randomUUID().replace(/-/g, '')}`;
}

function apiError(data, httpStatus) {
  const e = new Error((data && data.message) || `HTTP ${httpStatus}`);
  e.apiStatus = data && data.status;
  e.httpStatus = httpStatus;
  return e;
}

async function gwRequest(method, pathname, { body, extraParams = {}, token } = {}) {
  const params = new URLSearchParams({
    product_id: String(config.productId),
    language: config.language,
    ...extraParams,
  });
  const url = `${GW}${pathname}?${params}`;
  const headers = {
    Authorization: `Bearer ${token || guestToken(config.productId)}`,
    'User-Agent': UA,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    err.isNetwork = true;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (res.status >= 400 || (data && data.status !== undefined && !API_OK.has(data.status))) {
    throw apiError(data, res.status);
  }
  return data;
}

async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 根据魔数识别图片类型
function sniffImage(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.length > 6 && buf.toString('ascii', 0, 6) === 'GIF87a') return { ext: 'gif', mime: 'image/gif' };
  if (buf.length > 6 && buf.toString('ascii', 0, 6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (buf.length > 2 && buf.toString('ascii', 0, 2) === 'BM') return { ext: 'bmp', mime: 'image/bmp' };
  return null;
}

// ---------- 核心:抠图 ----------
// 1) 拿 OSS 上传授权  2) 直传 OSS(带回调拿 resource_id)
// 3) 创建 segmentation 任务  4) 轮询  5) 取无水印高清图下载返回
async function cutout(imageBuf, opts = {}) {
  const info = sniffImage(imageBuf);
  if (!info) throw Object.assign(new Error('不支持的图片格式,仅支持 png/jpg/webp/gif/bmp'), { httpStatus: 415 });
  const filename = `image.${info.ext}`;
  // 同一个任务始终复用同一份身份。这样账号 token 会真正生效，游客模式也不会
  // 在上传、建任务和轮询之间不断更换访客身份。
  const sessionToken = config.accountToken || guestToken(config.productId);

  // 1. OSS 授权
  const oss = await gwRequest('POST', '/authorizations/oss', { body: { filenames: [filename] }, token: sessionToken });
  const d = oss.data;
  if (!d || !d.credential || !d.objects) throw Object.assign(new Error('OSS 授权响应异常'), { httpStatus: 502 });
  const { access_key_id, access_key_secret, security_token } = d.credential;
  const objectKey = d.objects[filename] || Object.values(d.objects)[0];
  const uploadUrl = `https://${d.bucket}.${d.accelerate}/${objectKey}`;

  // 2. 直传 OSS,带签名
  const gmt = new Date().toUTCString();
  const callback = Buffer.from(JSON.stringify({
    callbackUrl: d.callback.url,
    callbackBody: d.callback.body,
    callbackBodyType: d.callback.type,
  })).toString('base64');
  const ossHeaders = {
    'X-Oss-Date': gmt,
    'X-Oss-Security-Token': security_token,
    'Content-Type': info.mime,
    'X-Oss-Callback': callback,
  };
  const lower = {};
  for (const [k, v] of Object.entries(ossHeaders)) lower[k.toLowerCase()] = v;
  const canonicalHeaders = Object.keys(lower)
    .filter((k) => k.startsWith('x-oss-'))
    .sort()
    .map((k) => `${k}:${lower[k]}`)
    .join('\n');
  const stringToSign = ['PUT', '', info.mime, gmt, canonicalHeaders, `/${d.bucket}/${objectKey}`].join('\n');
  const signature = crypto.createHmac('sha1', access_key_secret).update(stringToSign, 'utf8').digest('base64');
  ossHeaders.Authorization = `OSS ${access_key_id}:${signature}`;

  let up;
  try {
    up = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: ossHeaders,
      body: imageBuf,
    }, 60000);
  } catch (err) {
    throw Object.assign(new Error(`OSS 上传失败: ${err.message}`), { httpStatus: 502 });
  }
  const upText = await up.text().catch(() => '');
  let upData = null;
  try { upData = JSON.parse(upText); } catch (e) { /* XML 错误体 */ }
  if (up.status >= 300 || !upData || !upData.data || !upData.data.resource_id) {
    throw Object.assign(new Error(`OSS 上传失败: HTTP ${up.status} ${upText.slice(0, 300)}`), { httpStatus: 502 });
  }
  const resourceId = upData.data.resource_id;

  // 3. 创建任务
  const task = await gwRequest('POST', '/tasks/login/segmentation', {
    body: {
      website: config.language,
      source_resource_id: resourceId,
      output_type: 1,
    },
    token: sessionToken,
  });
  const taskId = task.data && task.data.task_id;
  if (!taskId) throw Object.assign(new Error(`创建任务失败: ${JSON.stringify(task).slice(0, 200)}`), { httpStatus: 502 });

  // 4. 轮询直到完成
  const deadline = Date.now() + config.timeoutSec * 1000;
  let result = null;
  while (Date.now() < deadline) {
    result = await gwRequest('GET', `/tasks/login/segmentation/${taskId}`, { token: sessionToken });
    const rd = result.data || {};
    if (rd.image || rd.progress === 100) break;
    if (rd.status && rd.status !== 0 && rd.status !== 100 && rd.status !== 'processing' && rd.status !== 200) {
      // 任务失败状态
      throw Object.assign(new Error(`任务失败: ${JSON.stringify(rd).slice(0, 200)}`), { httpStatus: 502 });
    }
    await sleep(config.pollMs);
  }
  if (!result || !((result.data || {}).image || (result.data || {}).progress === 100)) {
    throw Object.assign(new Error('任务超时'), { httpStatus: 504 });
  }

  // 5. 取图:优先走 image-url 接口(无水印高清),失败则回退任务结果里的图
  let imageUrl = null;
  const picQuality = opts.quality || config.picQuality;
  if (config.hd && !opts.noHd) {
    try {
      const img = await gwRequest('GET', `/tasks/login/image-url/segmentation/${taskId}`, {
        extraParams: { pic_quality: picQuality },
        token: sessionToken,
      });
      imageUrl = img.data && img.data.image;
    } catch (e) { console.warn('[warn] image-url 接口失败,回退任务结果图:', e.message); }
  }
  if (!imageUrl) imageUrl = result.data.image;
  if (!imageUrl) throw Object.assign(new Error('结果图中没有图片地址'), { httpStatus: 502 });

  let out;
  try {
    out = await fetchWithTimeout(imageUrl, { headers: { 'User-Agent': UA } }, 120000);
  } catch (err) {
    throw Object.assign(new Error(`下载结果图失败: ${err.message}`), { httpStatus: 502 });
  }
  if (out.status >= 400) throw Object.assign(new Error(`下载结果图失败: HTTP ${out.status}`), { httpStatus: 502 });
  return Buffer.from(await out.arrayBuffer());
}

// ---------- HTTP 服务 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_SIZE) { reject(Object.assign(new Error('图片超过大小限制'), { httpStatus: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 极简 multipart 解析:只取第一个文件字段的内容
function extractFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = `--${m[1] || m[2]}`;
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const headerEnd = buf.indexOf('\r\n\r\n', start);
  if (headerEnd < 0) return null;
  const dataStart = headerEnd + 4;
  const end = buf.indexOf(`\r\n${boundary}`, dataStart);
  if (end < 0) return null;
  return buf.subarray(dataStart, end);
}

function checkAuth(req) {
  if (!config.apiKey) return true;
  const key = req.headers['x-api-key'] || new URL(req.url, 'http://x').searchParams.get('key');
  return key === config.apiKey;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/test') {
      // 简单的浏览器测试页:拖图片进去,直接返回抠图结果
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>抠图测试</title></head>
<body style="font-family:sans-serif;max-width:960px;margin:40px auto;text-align:center">
<h2>佐糖抠图 API 测试</h2>
<p>把图片拖进框里,抠图结果自动下载(也可传入 API Key)</p>
<div id="box" style="border:3px dashed #999;border-radius:12px;padding:60px;margin:20px;color:#666">拖图片到这里</div>
<p>API Key(未设置则留空): <input id="key" style="padding:4px;width:200px"></p>
<div id="msg"></div>
<img id="out" style="max-width:100%;display:none;margin-top:16px">
<script>
const box=document.getElementById('box'),msg=document.getElementById('msg'),img=document.getElementById('out');
box.ondragover=e=>{e.preventDefault();box.style.borderColor='#55f'};
box.ondragleave=()=>box.style.borderColor='#999';
box.ondrop=async e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(!f)return;
  msg.textContent='抠图中...';img.style.display='none';
  const r=await fetch('/api/cutout',{method:'POST',headers:{'x-api-key':document.getElementById('key').value.trim()},body:f});
  if(!r.ok){msg.textContent='失败: '+(await r.text());return;}
  const b=await r.blob();const u=URL.createObjectURL(b);img.src=u;img.style.display='block';
  const a=document.createElement('a');a.href=u;a.download=f.name.replace(/\\.[^.]+$/,'')+'_cutout.png';a.click();
  msg.textContent='完成';
};
</script></body></html>`);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, {
        service: 'picwish-cutout-api',
        status: 'ok',
        auth: config.accountToken ? 'account' : 'guest',
        usage: 'POST /api/cutout   (multipart 字段 image,或直接传图片二进制;查询参数 hd=0 可关高清)',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/cutout') {
      if (!checkAuth(req)) return json(res, 401, { error: 'API key 错误' });
      const rawCt = req.headers['content-type'] || '';
      const raw = await readBody(req);
      // 注意:extractFile 需要用原始大小写的 boundary,不能传 toLowerCase 后的 ct
      const fileBuf = rawCt.toLowerCase().startsWith('multipart/') ? extractFile(raw, rawCt) : raw;
      if (!fileBuf || fileBuf.length === 0) return json(res, 400, { error: '没有收到图片' });
      console.log(`[${new Date().toISOString()}] 收到抠图请求,大小 ${(fileBuf.length / 1024).toFixed(0)} KB`);
      const out = await cutout(fileBuf, {
        quality: url.searchParams.get('quality') || undefined,
        noHd: url.searchParams.get('hd') === '0',
      });
      console.log(`[${new Date().toISOString()}] 抠图完成,结果 ${(out.length / 1024).toFixed(0)} KB`);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': out.length,
        'X-PicWish-Task': 'done',
      });
      return res.end(out);
    }
    return json(res, 404, { error: '未找到路径' });
  } catch (err) {
    const code = err.httpStatus || (err.isNetwork ? 502 : 500);
    console.error(`[${new Date().toISOString()}] 错误:`, err.message);
    return json(res, code, { error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`佐糖抠图反代已启动: http://${config.host}:${config.port}`);
  console.log(`认证模式: ${config.accountToken ? '账号 token' : '游客(免登录)'},产品ID: ${config.productId},高清: ${config.hd ? config.picQuality : '关'}`);
  if (!config.apiKey) console.log('警告: 未设置 apiKey,任何人都能使用该服务');
  console.log('用法: curl -X POST http://127.0.0.1:' + config.port + '/api/cutout --data-binary @test.png -o out.png');
});
