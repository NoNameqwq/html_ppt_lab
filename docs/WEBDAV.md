# WebDAV 云端备份

在「API 设置 → 云端备份」或顶部云朵按钮中填写 WebDAV 接口地址、账号、密码和备份目录，启用挂载后保存。地址应是服务提供的 WebDAV 接口，例如 `https://host.example/dav/`，不在地址中填写密码。支持「测试连接」「立即备份」「查看云端备份」「下载」和「恢复」。云端目录直接保存 ZIP 备份，无需映射系统盘符。

默认每天 03:00（Asia/Shanghai，可修改时间和时区）自动备份。第一次启用或错过备份，会在下一次调度时补做；失败后至少间隔 10 分钟再尝试。BAT 模式需要后端运行；单文件模式需要网页保持打开，关闭后在下次打开补做。网页和服务均不运行时无法上传。

备份包含工程源码、素材、对话及压缩记忆、历史版本、编辑记录、自定义模板和元素收藏。ZIP 使用 DEFLATE 压缩和逐文件 SHA-256 校验，先上传临时文件，再以 MOVE 完成备份。目录列表只展示完整备份。当前上限为压缩后 256 MB、展开后 1 GB、25,000 个文件，不包含临时事务和依赖目录。

API 配置和密钥默认不进入备份，可由用户勾选包含。WebDAV 账号密码配置独立于 Agent 设置接口，WebDAV 密码始终不进入云端 ZIP。BAT 配置保存在 `data/webdav/config.json`；单文件配置保存在浏览器工作区，导出私有工作台或本地 JSON 时可携带。

恢复前下载并校验整个备份，然后保存恢复前的本地 ZIP 副本。恢复合并项目，覆盖同名文件，保留额外本地项目和文件；完成后自动刷新工作台。对话和画布写入在恢复期间暂停，避免旧内容覆盖恢复结果。可在设置的状态卡下载本地恢复副本；BAT 副本存放在 `data/webdav/recovery/`，单文件模式保留最近一份恢复副本。BAT 和单文件备份格式不同，需要在对应模式中恢复。

单文件工作台直接连接云盘。WebDAV 服务需允许页面来源（`file://` 通常为 `null`）跨域，支持 OPTIONS、PROPFIND、MKCOL、PUT、MOVE、GET，允许 Authorization、Depth、Destination、Overwrite、If-None-Match 和 Content-Type 请求头。若云盘不支持浏览器跨域，可使用 BAT 模式连接。

验证：`npm run test:webdav`、`npm run qa:agent`、`npm run qa:static`。测试使用本机模拟 WebDAV 服务和隔离工作区。
