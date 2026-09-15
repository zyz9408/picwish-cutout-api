# 佐糖(PicWish)抠图 API 反代服务

把佐糖网页版的抠图功能包装成 HTTP API,别人(或你自己的程序)可以直接调用。
零依赖,Node 18+ 直接运行。

## 启动

```bash
node server.js
```

默认监听 `http://127.0.0.1:8787`，适合由同机 Nginx 提供 HTTPS 反向代理。

浏览器打开 `http://127.0.0.1:8787/test` 可以拖图片快速测试。

## 调用方式

```bash
# 方式一:直接传图片二进制(推荐,最简单)
curl -X POST http://127.0.0.1:8787/api/cutout --data-binary @test.png -o out.png

# 方式二:multipart 表单
curl -X POST http://127.0.0.1:8787/api/cutout -F "image=@test.png" -o out.png
```

返回:直接就是抠好的 **PNG 图片二进制**。失败时返回 JSON `{"error": "..."}`。

同时提供兼容 PicWish 官方调用格式的端点，供只支持 `X-API-KEY` + multipart 的前端使用：

```bash
curl -X POST https://你的域名/api/tasks/visual/segmentation \
  -H "X-API-KEY: 你的反代Key" \
  -F "image_file=@test.png"
```

成功响应保持 `{"status":200,"data":{"image":"..."}}` 结构。

可选查询参数:

- `?quality=hd` 高清原分辨率(默认);`?quality=free` 低分辨率预览(约缩到 640px);`standard` 同 hd
- `?hd=0` 跳过高清接口,直接用任务结果图
- `?key=你的key` 代替 `x-api-key` 请求头

Python 调用示例:

```python
import requests
r = requests.post("http://127.0.0.1:8787/api/cutout", data=open("in.jpg", "rb").read())
open("out.png", "wb").write(r.content)
```

## 两种认证模式(见 config.json)

| 配置 | 说明 |
|---|---|
| `accountToken` 留空 | **游客模式**,自动生成游客 token,免登录直接可用(每天有次数限制) |
| `accountToken` 填你的账号 token | **账号模式**,使用你登录的账号额度,额度更高 |

### 怎么拿你的账号 token(账号模式)

1. 浏览器打开 [picwish.cn](https://picwish.cn) 并登录你的账号
2. 按 F12 → Console(控制台),粘贴回车:

   ```js
   localStorage.getItem('passport_api_token')
   ```

3. 复制输出的一长串字符,粘到 config.json 的 `accountToken` 字段,重启服务

> 输出 `null` 说明该浏览器未登录佐糖。token 属于敏感凭证,不要外泄;过期后重复上面的步骤换新。
>
> 注意:佐糖桌面网页版官方不支持微信/QQ 登录(点击会提示"只能在 APP 中使用"),桌面端只能手机验证码登录;桌面客户端另有一套原生登录流程。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | 127.0.0.1 | 监听地址；通过 Nginx 对外时不要改成公网地址 |
| `port` | 8787 | 服务端口 |
| `apiKey` | 空 | 设置后客户端必须带 `x-api-key` 头或 `?key=` 参数 |
| `accountToken` | 空 | 佐糖账号 Bearer token |
| `productId` | 482 | 产品 ID:网页版 482,桌面客户端 492 |
| `language` | en | 网关请求语言参数 |
| `hd` | true | true=走 image-url 接口取无水印高清图 |
| `picQuality` | hd | image-url 接口画质参数:hd 原分辨率,free 约 640px |
| `maxSizeMB` | 15 | 上传上限 |
| `timeoutSec` | 120 | 单任务总超时 |
| `pollMs` | 800 | 轮询间隔 |

环境变量也可覆盖:`CUTOUT_HOST`、`CUTOUT_PORT`、`CUTOUT_API_KEY`、`CUTOUT_ACCOUNT_TOKEN`。

## Linux 服务器部署

```bash
git clone https://github.com/zyz9408/picwish-cutout-api.git /www/wwwroot/picwish-cutout-api
cd /www/wwwroot/picwish-cutout-api
cp config.example.json config.json
node server.js
```

生产环境建议用宝塔 Node 项目管理器或 systemd 守护进程，并在已有 HTTPS 站点中只反代 API 路径：

```nginx
location = /api/cutout {
    client_max_body_size 15m;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    proxy_pass http://127.0.0.1:8787/api/cutout;
}

location = /api/tasks/visual/segmentation {
    client_max_body_size 15m;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    proxy_pass http://127.0.0.1:8787/api/tasks/visual/segmentation;
}

location = /health {
    proxy_pass http://127.0.0.1:8787/health;
}
```

## 给别人使用

1. 设好 `apiKey`,把端口映射到公网(云服务器部署,或内网穿透如 frp/ngrok)
2. 告诉别人:POST `http://你的地址/api/cutout`,头带 `x-api-key: 你设的key`

## 工作原理

```
客户端 ──POST 图片──▶ 本服务 ──▶ gw.aoscdn.com(佐糖网关,带会话 token)
                           1. /authorizations/oss      拿 OSS 上传授权
                           2. PUT 图片到 OSS(带签名)   得 resource_id
                           3. /tasks/login/segmentation 创建抠图任务
                           4. 轮询任务状态
                           5. /tasks/login/image-url/... 取无水印结果图
客户端 ◀──PNG 结果── 本服务 ◀── 下载结果图
```

## 风险提示

- 这是非官方接口,佐糖可能随时改接口、限流、封禁异常请求的账号
- 免费额度有限,高频使用建议购买官方 API(见 picwish.cn/background-removal-api-doc)或佐糖会员
- 若批量对外提供服务,请自行评估服务条款风险
