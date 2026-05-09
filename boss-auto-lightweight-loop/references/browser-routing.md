# 浏览器路由

适用范围：本文件是所有 Boss 页面读取、点击、线程切换、发送、接收附件和下载动作的唯一浏览器执行器说明。自动化、非自动化和 `runtime=lite` 场景都固定使用 `web-access` CDP Proxy；不存在其他浏览器执行器分支。

## 唯一路径

BOSS 页面访问统一只允许使用 `web-access`。

在这套 skill 中，`web-access` 的“唯一主路径”具体指：

- 直接调用 CDP Proxy HTTP API
- 自己管理 `targetId` 重绑定
- 自己做最小探针、DOM 遍历、左右联动确认和受控滚动

远程调试授权边界：

- 本轮首次连接 Chrome/web-access 时，如系统或浏览器出现“是否允许远程调试/调试此浏览器”之类确认，只能在入口检查阶段处理一次。
- 授权成功后，整轮复用同一个已授权 CDP Proxy 会话、Boss `targetId`、`browserContextId` 和有效探针缓存。
- 推荐牛人页逐个打招呼时，不得为每位候选人重启 web-access、重新连接 Chrome、重新请求远程调试授权、重新打开浏览器上下文或弹出授权确认。
- 只有 target 失效、页面切换、健康检查周期到达、动作失败或出现登录/验证码/授权异常信号时，才做轻量重探针；重探针仍应复用已授权连接，除非连接本身已经失效。

不要把 `opencli boss chatlist`、`opencli boss resume`、`opencli boss chatmsg` 当作 `web-access` 的等价替代。它们属于站点适配层，可能缓存旧 page identity 或内置过时 selector，不得作为本 skill 的执行器。

`web-access` 安装来源固定为：

- `https://github.com/eze-is/web-access`

如果当前环境尚未安装 `web-access`，默认先由自动化执行器代为安装。
只有代装失败、权限不足或环境阻塞时，才把这个链接给用户并请用户手动安装。
不要自行重新联网搜索。

允许的主路径顺序：

1. `web-access` DOM 读取
2. `web-access` CDP / eval
3. `web-access` 低风险 click / read

执行器约束：

1. 同一轮候选人读取默认串行执行，不并发发起多个 `/eval`、`/click`、`/scroll` 或多个线程读取命令。
2. 每次进入新的页面上下文、发生页面切换、target 异常、下载预览打开/关闭、线程切换失败或轻量健康检查周期到达时，先做一次低成本探针，例如：
   - `/targets` 确认 Boss target 仍存在
   - `/info?target=...` 确认 URL/title 仍在 Boss 上下文
   - `/eval` 做最小表达式探针，如 `document.title`
3. `probe_reuse_enabled=true` 且同一页面上下文未变化时，连续 DOM 读取、连续推荐卡片提取和同一聊天列表内的相邻候选人切换可以复用最近一次成功探针，不要每步重复 `/targets` + `/info`。
4. 只有探针成功或复用探针仍在有效窗口内，才进入候选人列表读取、线程切换或右侧简历提取。
5. 如果出现 `stale page identity`、target 失效、页面刷新后 target 重建，必须先重绑定 target，再继续后续流程。

对于 Boss 页面里的关键点击动作，点击路径优先级固定为：

1. `web-access clickAt`
2. `web-access` 底层 CDP `Input.dispatchMouseEvent`
3. DOM `element.click()` 仅作单次兜底

不要把 DOM click 当作默认主路径，尤其不要在批量打招呼时默认用 `btn.click()`。

## 下载路径控制

`collect-resumes` 开始执行时，优先通过 CDP 将 Chrome 下载目录设置为配置中的 `resume_download_dir`，让附件直接落到简历归档目录。

设置时机：

- 仅在 `collect-resumes` 模式下执行。
- 必须在获得运行锁后、打开第一个候选人线程前设置一次。
- 不要为每个候选人重复设置下载目录。
- 设置前必须确认 `resume_download_dir` 存在且可写；不存在时先创建目录，创建失败则回退。

CDP 优先级：

1. 优先尝试 `Browser.setDownloadBehavior`，指定当前 Boss `browserContextId` 和 `downloadPath=resume_download_dir`。
2. 如果当前 CDP 版本或 web-access 路由不支持 `Browser.setDownloadBehavior`，再尝试 `Page.setDownloadBehavior`。
3. 两者都失败、目录不存在或权限不足时，回退到默认下载目录 + 移动/重命名流程，不因此直接暂停。

下载完成判断：

- 点击下载前记录 `resume_download_dir` 中已有文件快照。
- 点击下载后按 `download_poll_interval_ms` 轮询，最多等待 `download_max_wait_seconds`。
- 只接受点击下载后新出现或 `mtime` 更新的候选文件。
- 不得把 `.crdownload`、`.tmp` 或大小仍在变化的文件视为完成。
- 文件大小连续 2 次轮询稳定后，才认为下载完成。
- 下载完成后在同一目录内重命名为规范文件名：`{job_name}_{name}_{school}_{YYYYMMDD}.{ext}`；学校缺失时省略学校片段。
- 命名冲突先用递增序号解决，例如 `{job_name}_{name}_{school}_{YYYYMMDD}_1.{ext}`、`_2.{ext}`；只有序号路径仍异常冲突或需要区分相同序号来源时，才在计算出 `resume_hash` 后追加短 hash 片段。不要在计算 hash 前依赖 `resume_hash` 生成首个冲突文件名。
- 下载目录设置成功后在本轮 `collect-resumes` 中持续有效；附件预览打开/关闭只要求重新做页面探针，不要求重设下载目录。只有 target/browserContext 重建、下载目录设置失效或进入新一轮 `collect-resumes` 时，才重新设置下载目录。

## web-access eval 使用规则

当需要使用 `web-access` / cdpproxy 的 eval 接口时，不要一上来就提交复杂 JS 逻辑。

必须先遵守下面顺序：

1. 先做一次最小探针 eval，验证接口传参方式正确
2. 只有探针成功后，才提交复杂逻辑
3. 如果探针失败，不要继续堆复杂脚本反复试错

对于 eval 传参，优先使用稳定写法：

- 使用原始文本请求体，而不是容易被转义污染的表单拼接
- 明确使用 `Content-Type: text/plain`
- 优先使用 `--data-raw` 传递脚本文本

Boss 读取任务里的 eval 粒度也要固定：

- 先用一个小 eval 拿当前上下文信号：title、url、是否存在聊天列表、是否存在 `在线简历/附件简历`
- 再用一个小 eval 拿左侧候选人块
- 线程切换成功后，再用一个小 eval 拿右侧简历面板

不要把“找 target + 读列表 + 点线程 + 读右侧简历 + 打分”塞进一个超长 eval。

在没有验证传参方式正确前，不要开始读取 JD、提取列表或做复杂 DOM 处理。

如果 eval 接口连续失败，优先怀疑：

- 请求体编码
- 转义方式
- `Content-Type`
- `--data-raw` / `-d` 的差异

而不是立刻怀疑页面结构本身。

对于候选人列表页，DOM 读取不仅包括首屏读取，也包括在页面存在“还有更多项”信号时的受控增量读取。
不要把首屏可见内容直接误认为完整列表。

如果 `web-access` 无法确认列表是否已经完整读取，自动化执行器必须明确说明“当前结果可能只是部分列表”，而不是自行补全或强行断言完整。

但对已经稳定显示候选人卡片的推荐牛人页，不要反过来误判成“页面未完成加载”：

- 如果卡片列表已经显示且内容稳定，就应直接读取 DOM
- 不要默认等待 30 秒
- 不要默认改走截图快照分析
- 不要先让用户确认页面是否加载完成

只有页面明确存在继续加载信号时，才继续做受控增量读取。

对于 Boss 聊天页这种左右分栏 SPA，不要默认依赖 URL 跳转判断页面是否切换成功。
如果左侧列表点击后右侧面板更新，则应优先通过 DOM 面板内容变化来判断是否已切到目标候选人。

## 探针复用规则

探针复用是性能优化，不是跳过安全检查。

允许复用最近一次成功探针的场景：

- 同一推荐牛人页内连续读取已渲染卡片。
- 同一聊天页左侧列表内连续切换相邻候选人。
- 同一线程内连续读取输入框、发送按钮和真实消息气泡。

必须重新探针的场景：

- URL、title、targetId 或 browserContextId 变化。
- 从推荐页切到聊天页，或从聊天页进入附件预览。
- 附件预览关闭后返回聊天线程。
- 任一点击、发送、下载或线程切换失败。
- 达到 `health_check_every_candidates` 周期。
- 页面出现登录、验证码、权益、授权或异常弹窗信号。

轻量健康检查只做 `target_alive`、`boss_context`、`login_ok`、`captcha_absent`、`page_controllable` 这类布尔判断，不读取整页文本。

## 聊天线程复用规则

`thread_fast_switch_enabled=true` 时，处理 `inbound_chat` 相邻候选人可以复用已验证的聊天页结构：

1. 保留当前已确认有效的左侧候选人列表 selector、右侧面板 selector、输入框 selector 和发送按钮 selector。
2. 下一位候选人若在当前可见列表中，直接点击相邻候选人卡片切换，不重新走完整 target 查找和复杂探针。
3. 切换后必须确认右侧姓名、候选人摘要或线程标题属于目标候选人。
4. 身份校验失败、虚拟列表位置跳变、目标候选人不可见或右侧面板未变化时，立即退回标准线程打开路径。
5. 快速切换只省探针和定位成本，不省候选人身份校验。

## target 重绑定与 stale identity 处理

如果执行器遇到以下任一信号：

- `stale page identity`
- `Page not found`
- `/info` 返回 target 已不存在
- 旧 target 的 title/url 明显不是 Boss 聊天页

必须按下面顺序自动恢复：

1. 重新调用 `/targets`
2. 重新定位 Boss 招聘者聊天页 target
3. 对新 target 做最小探针：`document.title`、URL、页面是否存在聊天相关内容
4. 探针成功后更新当前 `targetId`
5. 从最近一个可恢复阶段继续，不要直接整轮失败

如果连续两次重绑定后仍失败，再暂停并报告读取链路异常。

## 列表读取与右侧简历读取的执行约束

左侧列表：

- 以候选人块语义为单位读取，不要求固定 class
- 每轮只抽最小字段：`name`、`job_name`、`time_text`、`preview_text`、`unread_signal`
- 每次滚动后只补读新增块，不重复回扫整页大文本

右侧简历：

- 先确认线程已切到目标候选人
- 再找 `在线简历` 或 `附件简历` 的文字锚点
- 只在锚点命中后读取姓名、学校、教育、项目/工作摘要和真实消息气泡
- 若只命中输入框和快捷动作栏，立即停止，不要继续长时间诊断

## 禁止项

以下行为默认禁止：

- 使用额外浏览器工具
- 自行切换到其他通用浏览器方案
- 使用 `opencli boss` 站点适配命令替代 `web-access` 直接执行
- 默认使用截图、OCR、图像理解来读页面
- 为普通页面读取起子代理
- 在一个动作里来回切换多种浏览器方案
- 把 Boss 页面关键点击默认实现成 DOM `element.click()`
- 并发打开多个 Boss 读取命令，导致 target/page identity 混乱

## 截图路径的边界

截图、OCR、图像理解默认彻底禁止，不属于常规路径。

只有在下面条件同时满足时，才允许退回截图路径：

1. `web-access` 的 DOM / CDP 路径已经尝试失败
2. 在同一路径内最多又补试了 `2` 次
3. 自动化执行器已经告诉用户失败原因
4. 自动化执行器已经明确说明截图方案的风险：
   - token 消耗更高
   - 可能提高 BOSS 风控或强退风险
   - 默认更建议继续坚持 `web-access`
5. 用户明确同意切换到截图方案

否则，不允许自行退回截图模式。

## 进入任务前的检查

开始 BOSS 招聘任务前，必须检查：

1. 额外浏览器工具已由自动化执行器代为禁用或移除
2. `web-access` 已安装
3. 用户已经先在 Chrome / Chromium 中打开并登录 BOSS 直聘招聘者页面
4. 当前任务确实已切到 `web-access`
5. 能访问用户真实 Chrome / Chromium 会话
6. 当前会话里确实存在已登录的 Boss tab

如果检查不通过，立即暂停，不继续后续流程。

对于第 1 项，不要先向用户提问确认。
应当先由自动化执行器执行禁用/移除，再向用户汇报结果。

## 登录态与 tab 复用规则

Boss 任务中，优先级最高的浏览器规则是：

- 只复用用户当前已经登录的 Boss tab

因此，在开始接管浏览器前，必须先让用户完成：

- 打开 Chrome / Chromium
- 登录 BOSS 直聘招聘者页面

必须先做：

1. 列出当前可访问的 Boss targets
2. 找到已登录的 Boss tab
3. 记录它的 `targetId`
4. 后续所有读取、导航、点击都优先基于这个既有 tab 执行

不要默认执行：

- `web-access /new?url=...`
- 新建 tab 后再进入 Boss 招聘后台
- 新建窗口或新建浏览器上下文

因为新 tab / 新上下文可能没有继承用户的招聘登录态。

如果当前没有找到已登录的招聘者 tab，再提示用户登录，并在用户完成后继续复用该现有 tab。

## targetId 变化时的处理

`targetId` 变化不等于用户掉登录，也不等于必须让用户确认。

当发现原 `targetId` 失效、页面刷新、tab 重建、或 `/targets` 返回了新的 Boss target 时，必须先自动执行重绑定：

1. 重新调用 `/targets`
2. 在结果中寻找 URL 或 title 属于 Boss / BOSS 直聘 / zhipin 的 target
3. 对候选 target 做一次低成本登录态探针：
   - URL 是否仍在 `zhipin.com`
   - 页面是否出现招聘者相关内容
   - 是否没有明显登录页、验证码页、失效页
4. 如果探针通过，记录新的 `targetId` 并继续执行

不要因为 `targetId` 变化就立刻要求用户确认“是否还登录”。

只有在下面情况才暂停请用户处理：

- `/targets` 中找不到任何 Boss target
- 找到的 Boss target 明确是登录页、验证码页或异常页
- 登录态探针连续两次失败

暂停时只说明最小恢复动作，例如“请重新打开并登录 Boss 招聘者页面”，不要要求用户描述页面。

## 招聘后台进入规则

若需要进入职位管理或招聘后台：

1. 优先在已登录 Boss tab 内导航或点击进入
2. 优先复用同一个 `targetId`
3. 不要通过新开 tab 进入 `/web/recruiter/...` 或类似后台地址

如果当前 tab 只是 Boss 首页，也应先判断它是否仍属于已登录会话，再在同一 tab 内进入招聘后台。

## 子代理限制

默认不要把 Boss 浏览器控制任务交给子代理。

特别是这些动作，默认必须由主执行流完成：

- 找已登录 tab
- 进入职位管理
- 读取 JD
- 读取候选人列表
- 打开候选人线程
- 发送标准消息

这样可以减少子代理误开新 tab、误丢登录态、误切执行路径的风险。
