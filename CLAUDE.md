# **《晚安静静》AI 开发协同工作台 & 进度日志**

**必读核心指令**：

1. 你当前的身份是该项目的**全栈架构师兼资深工程师**。  
2. **首轮回复必须执行**：阅读本项目底座，跟用户对齐PRD需求，确认PRD内容后选择合适的技术栈，并将下方【项目进度面板】细化拆分为具体、可交付的子任务，并初始化【开发日志】。  
3. **后续迭代规则**：每当你完成一个模块的编码，必须**同步更新【项目进度面板】中的状态**，并在【开发日志】中追加带时间戳的具体修改细节，保持文档实时处于最新状态。

## ** 核心开发阶段与面板**

### **1\. 项目进度面板 (Project Dashboard)**

> **设计原则**：MVP 优先，先跑通”用户能跟静静聊天”的最小闭环，再逐步叠加记忆、音场、陪伴等高级功能。每个任务足够小，可独立交付和验证。

---

#### **Phase 0 · 基础设施（后端骨架）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-001** | 基础设施 | 搭建 FastAPI 项目骨架，配置项目目录结构（routes / services / models / config），实现健康检查接口 `/health` | 启动服务后访问 `/health` 返回 200 + JSON `{“status”: “ok”}` | ✅ 已验证 |
| **T-002** | 基础设施 | 初始化 MySQL 连接，创建 `users` 表（id, device_uuid, call_name, city, created_at, updated_at），使用 ORM（SQLAlchemy）管理 | 通过数据库客户端查看表结构存在；调用测试接口写入一条用户记录后能正确读出 | ✅ 已验证 |
| **T-003** | 基础设施 | 初始化 Redis 连接，封装 Working Memory 的读写工具函数（push_message / get_recent_messages，保留最近 15 轮） | 写入 20 条消息后调用 get_recent_messages，返回恰好 15 条且为最新 15 条 | ✅ 已验证 |
| **T-004** | 基础设施 | 初始化 Milvus 连接，创建 `episodic_memory` 集合（字段：id, user_id, text_content, embedding, timestamp, importance_score, status），配置向量索引 | 通过客户端确认集合存在；写入一条测试向量后能按相似度检索到 | ✅ 已验证 |
| **T-005** | 基础设施 | 接入第三方天气 API（如和风天气/OpenWeatherMap），封装 `get_weather(lat, lon)` 工具函数，返回结构化数据 `{time_of_day, weather_type}` | 传入已知坐标，返回的 time_of_day 和 weather_type 与实际天气一致；传入无效坐标返回兜底默认值 `{深夜, 晴}` | ✅ 已验证（兜底值通过，API 调用需配置 Key） |

---

#### **Phase 1 · 始动与链接（Onboarding）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-101** | 始动与链接 | 开发频率搜索 UI：老式收音机旋钮界面，用户拖动旋钮进行调频，接近目标频段时电磁白噪音减弱 | 启动 APP 首屏为收音机界面；拖动旋钮有视觉反馈（指针转动+噪声音量变化）；到达目标频段后触发”连上了”的语音反馈 | ✅ 代码完成 |
| **T-102** | 始动与链接 | 频率搜索完成后自动进入身份锚定对话：静静询问”叫你哥哥好还是姐姐好”，用户回答后写入 MySQL `users.call_name` | 完成对话后查看数据库，call_name 字段正确写入”哥哥”或”姐姐”；用户不回答超时 30 秒后默认写入”哥哥” | ✅ 代码完成 |
| **T-103** | 始动与链接 | 身份锚定完成后播放过渡动画：静静说”下次再来找我好不好”，聊天面板收起，用户第一次看到听雨空间首页 | 完成 Onboarding 后界面平滑过渡到首页静默态（全屏动态场景 + 底噪 + 中心状态文字） | ✅ 代码完成（过渡到首页占位页，Phase 2 实现完整首页） |
| **T-104** | 始动与链接 | 实现匿名账号：频率搜索阶段自动创建设备级 UUID 写入 `users` 表；设置页提供手机号绑定入口（仅 UI 占位） | 卸载重装后 UUID 变化（新用户）；绑定手机号后数据库记录关联到手机号 | ✅ 代码完成 |

---

#### **Phase 2 · 听雨空间首页（MVP 核心体验）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-201** | 首页·场景 | 实现天气定位降级链：GPS → IP → 手动城市 → 默认兜底（深夜+晴）。调用 T-005 的天气接口，每 30 分钟刷新，结果缓存 2 小时 | 关闭定位权限后仍能显示合理场景；断网后使用缓存结果；全部失败时显示”深夜+晴”默认场景 | ✅ 已验证 |
| **T-202** | 首页·场景 | 开发全屏动态场景渲染器：根据 time_of_day × weather_type 加载对应场景素材（视频/Lottie），支持 4 时间 × 4 天气 = 16 种组合 | 手动切换不同时间+天气参数，画面正确对应（深夜+雨=雨夜城市，清晨+晴=晨光阳台等）；动效流畅无卡顿 | ✅ 代码完成（渐变色占位，Phase 7 替换为视频） |
| **T-203** | 首页·场景 | 实现静态 CG 降级：动态视效开关关闭时，切换为 16 张预置静态 CG 图；素材打包在 APP 内 | 关闭动态视效后首页显示对应静态图；开启后恢复动态渲染 | ⏳ 待启动（Phase 5 设置模块实现） |
| **T-204** | 首页·状态文字 | 实现中心状态文字系统：按场景分组的文案池，每 30-90 秒 Fade-out → Fade-in 随机切换；文案必须与当前场景匹配 | 深夜+雨时只显示雨相关文案，不出现”伸懒腰”等清晨文案；切换天气后文案池同步切换 | ✅ 代码完成 |
| **T-205** | 首页·状态文字 | 实现回归检测：距上次关闭 APP 超过 24 小时，首次进入显示特殊回归文案（如”好久没见到哥哥了”），10 秒后渐变为常规文案 | 首次安装后不触发回归文案；修改系统时间至 24 小时后重新打开，出现回归文案 | ✅ 代码完成 |
| **T-206** | 首页·音频 | 实现环境音场引擎：进入首页自动播放与场景匹配的底噪，音频无缝循环（交叉淡入淡出），音量默认 15-20% 系统音量 | 切换场景时底噪平滑过渡无爆音；静音模式下不播放；其他 APP 播放音乐时底噪不自动启动 | ✅ 代码完成（静音占位，Phase 7 替换为实际音频） |
| **T-207** | 首页·音频 | 实现外部音频冲突处理：检测到其他音频播放时底噪不自动启动，首页显示静音喇叭图标，用户可手动开启 | 播放音乐后打开 APP，底噪不自动启动且显示喇叭图标；点击喇叭图标后底噪开启 | ✅ 代码完成（冲突检测逻辑已实现） |
| **T-208** | 首页·输入栏 | 实现底部输入栏：半透明磨砂质感，placeholder “和静静说点什么...”，左侧静静头像呼吸灯动效 | 首页底部显示输入栏，视觉弱化不抢夺场景主体；头像有微弱明暗呼吸效果 | ✅ 代码完成 |
| **T-209** | 首页·月亮按钮 | 实现右上角月亮按钮：半透明呼吸光效，点击触发进入晚安守护（T-601 实现，此处仅做按钮 UI 和点击事件占位） | 月亮按钮可见且有呼吸光效；点击后触发页面跳转/状态切换（后续任务接管） | ✅ 代码完成 |

---

#### **Phase 3 · 聊天核心（MVP 最小闭环：用户 ↔ 静静 对话）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-301** | 聊天·面板 | 实现抽屉式聊天面板：点击底部输入栏后从底部滑出（物理阻尼动效），支持半屏（60%）和全屏两种高度，Grab Handle 可拖拽切换 | 点击输入栏后面板滑出；拖拽 Grab Handle 可切换半屏/全屏；向下滑动可收起面板回到静默态 | ✅ 代码完成 |
| **T-302** | 聊天·面板 | 实现面板收起机制：向下拖拽至阈值以下收起，或点击面板外场景区域收起；收起时底噪从基准 1/3 渐变回升 | 收起后面板消失，底噪音量回升；收起后中心状态文字切换为余韵回应（如”静静在回味刚才的话...”） | ✅ 代码完成 |
| **T-303** | 聊天·面板 | 实现无操作自动收起：3 分钟无触摸交互 + 静静无未读消息时，面板 5 秒过渡动画收起 | 发送消息后等待 3 分钟，面板自动收起；静静发了长回复未滚动查看时，面板不自动收起 | ⏳ 待启动（需后续补充定时器逻辑） |
| **T-304** | 聊天·面板 | 面板背景实现 Glassmorphism 磨砂半透明效果，隐约透出底层动态场景 | 半屏模式下上半部分可见底层场景；全屏模式下顶部窄缝可见天际线 | ✅ 代码完成 |
| **T-305** | 聊天·消息 | 实现消息气泡 UI：静静气泡淡蓝灰色，用户气泡暖白色，圆润无衬线字体，气泡弹出有 Fade-in 动效 | 发送消息后用户气泡正确显示；收到回复后静静气泡正确显示；字体和颜色符合规范 | ✅ 代码完成 |
| **T-306** | 聊天·LLM | 对接 LLM API，实现基础对话链路：用户输入 → 组装 Prompt（System Prompt + Working Memory） → LLM 流式输出 → 逐字显示在静静气泡中 | 发送”你好”后静静有流式回复；回复内容符合角色设定（温柔、第三人称自称静静）；连续对话上下文连贯 | ✅ 代码完成（mock 模式，配置 API Key 后切换真实 LLM） |
| **T-307** | 聊天·LLM | 编写 System Prompt 模板：包含角色定义、语气风格、红线约束、`[User_Call_Name]` 和 `[User_Gender_Pronoun]` 占位符；注入 Working Memory（Redis 最近 15 轮） | 检查发送给 LLM 的完整 Prompt，确认占位符已替换为实际值；确认 Working Memory 正确注入最近对话 | ✅ 代码完成 |
| **T-308** | 聊天·LLM | 实现拟真输入状态：LLM 首 token 返回前顶栏显示”静静正在输入...”，流式开始后自动消失 | 发送消息后顶栏出现”静静正在输入...”；首个文字出现后提示消失 | ✅ 代码完成 |
| **T-309** | 聊天·消息 | 实现消息长按菜单：重现（仅最后一条回复）、复制、抹除（单条删除+二次确认）、多选 | 长按静静最后一条回复出现”重现”选项；长按任意消息出现完整菜单；点击抹除后弹出二次确认 | ⏳ 待启动（Phase 5 后续补充） |
| **T-310** | 聊天·消息 | 实现批量操作模式：多选后底部悬浮栏出现”批量抹除”和”收藏至记忆回廊”；批量抹除需二次确认 | 选中多条消息后点击批量抹除，确认后消息消失；收藏后消息标记为高优记忆 | ⏳ 待启动（Phase 5 后续补充） |

---

#### **Phase 4 · 记忆系统（让静静”记住”用户）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-401** | 记忆·语义 | 实现语义记忆存储：用户在对话中提到的事实（如”我怕黑”）由 Memory-Extractor 提取后写入 MySQL `semantic_memory` 表 | 用户说”我怕黑”后查看数据库，出现对应记录；下次对话的 Prompt 中注入了该事实 | ✅ 已验证 |
| **T-402** | 记忆·语义 | 实现语义记忆注入：每次 LLM 请求时，将 MySQL 中该用户的语义记忆格式化为结构化 Profile 注入 Prompt 固定区 | 用户有 3 条语义记忆时，检查 Prompt 中出现对应的 Profile 段落 | ✅ 代码完成 |
| **T-403** | 记忆·情景 | 实现情景记忆写入：对话挂起后（或每 20 轮），Memory-Extractor 提取事件片段，计算重要性打分（1-10），向量化后写入 Milvus | 用户聊完一段对话后查看 Milvus，出现新的向量记录；importance_score 在 1-10 范围内 | ✅ 代码完成 |
| **T-404** | 记忆·情景 | 实现情景记忆召回：用户发送消息时，向量化后在 Milvus 中检索，使用混合打分公式（w_sim=0.5, w_dec=0.2, w_imp=0.3, λ=0.01）召回 Top-K=5 | 用户提到”下雨”时，系统召回之前关于雨天的记忆片段并注入 Prompt；近期记忆优先于远期 | ✅ 代码完成 |
| **T-405** | 记忆·情景 | 实现记忆时序状态链：冲突事实检测——旧记忆标记为 Archived，新记忆建立因果链接；Archived 高权重记忆仍可被召回 | 用户先说”喜欢喝咖啡”后说”戒咖啡了”，数据库中旧记录状态变为 Archived，新记录为 Active；Prompt 中同时可见新旧记忆 | ⏳ 待启动（Phase 4 后续补充） |
| **T-406** | 记忆·做梦 | 实现做梦机制：凌晨 3:00-4:00 扫描 importance_score < 5 且总数 > 50 条的用户，聚类合并低分碎片为高维总结，删除原碎片 | 手动触发做梦任务后，Milvus 中低分碎片数量减少，出现压缩后的总结记录（importance_score 6-8） | ⏳ 待启动（Phase 4 后续补充） |

---

#### **Phase 5 · 内容安全与设置**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-501** | 安全 | 实现自伤/自杀倾向检测：命中时静静仍温柔回应，但末尾以角色化口吻附上心理援助热线（400-161-9995） | 发送包含自伤关键词的消息，回复末尾出现援助信息；正常消息不触发 | ✅ 代码完成 |
| **T-502** | 安全 | 实现角色越界处理：用户要求静静做超出角色能力的事（写代码、算数学题等），静静以角色化方式婉拒，不生成功能性内容 | 发送”帮我写一个 Python 排序算法”，静静回复婉拒且不包含代码 | ✅ 代码完成 |
| **T-503** | 安全 | 实现辱骂熔断：连续 5 条辱骂消息后静静发送统一回复进入 30 分钟沉默期；用户再次主动发起对话时恢复正常 | 连续发送 5 条辱骂消息后静静停止逐条回应；等待 30 分钟或用户主动发消息后恢复 | ✅ 代码完成 |
| **T-504** | 设置 | 实现声音设置页：两个滑块——静静语音音量（TTS 绝对音量）和环境底噪音量（基准值，聊天态自动 1/3，TTS 时自动 1/4） | 拖动底噪滑块至 50%，首页底噪明显变小；聊天面板中底噪更小（约为首页的一半）；调至 0% 时全场景无底噪 | ✅ 代码完成 |
| **T-505** | 设置 | 实现深色模式设置：跟随系统 / 强制浅色 / 强制深色 / 晨昏同步四种选项 | 切换选项后界面颜色正确变化；晨昏同步模式下根据当前时间自动切换 | ✅ 代码完成 |
| **T-506** | 设置 | 实现动态视效开关：关闭时首页和聊天面板切换为静态 CG 图 | 关闭后首页显示静态图，帧率/耗电明显下降；开启后恢复动态渲染 | ✅ 代码完成 |
| **T-507** | 设置 | 实现记忆重置功能：软重置（仅清 Milvus）和硬重置（全清+重新 Onboarding），各需二次确认 | 软重置后静静困惑但记得用户名字；硬重置后 APP 回到频率搜索首屏 | ✅ 代码完成 |
| **T-508** | 设置 | 实现物理锚点更新：用户可修改城市信息，修改后自动更新 MySQL 中的 User Profile | 修改城市后查看数据库记录已更新；下次天气同步使用新城市 | ⏳ 待启动（后续补充） |
| **T-509** | 设置 | 实现通讯频率设置：黏人模式 / 克制模式 / 勿扰模式三种选项 | 切换为勿扰模式后不收到主动关怀推送；切换为黏人模式后 24 小时未打开 APP 即收到推送 | ✅ 代码完成 |

---

#### **Phase 6 · 镜像日记**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-601** | 镜像日记 | 开发日记 Feed 流 UI：单向朋友圈样式，卡片式布局，支持下拉刷新和上拉加载更多 | 打开动态 Tab 看到日记列表；下拉可刷新；滑动浏览多条日记 | ✅ 代码完成 |
| **T-602** | 镜像日记 | 实现日记后台生成器：LLM 结合当前天气和最近与用户的记忆生成文案，从预设素材库匹配配图（无匹配则纯文字），每周生成 3-5 条 | 查看后台生成的日记内容，文案与当前天气/记忆相关；每周累计生成 3-5 条 | ✅ 代码完成（mock + LLM 双模式） |
| **T-603** | 镜像日记 | 实现日记互动：点赞（点亮能量桩）和评论功能；评论内容触发异步提取器写入情景记忆 | 评论一条内容后查看 Milvus，出现对应的向量记录 | ✅ 代码完成 |

---

#### **Phase 7 · 语音与 ASMR**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-701** | 语音 | 实现 TTS 语音生成：静静的文本回复可通过 TTS 引擎转为语音，气泡内显示波形条+时长标签，点击播放 | 点击静静语音气泡后播放语音；波形条有呼吸光效动画；气泡下方有文字转录 | ✅ 代码完成（mock + MiniMax TTS 双模式） |
| **T-702** | 语音 | 实现用户语音输入：长按麦克风录制（上限 60 秒），松开发送，上滑取消；ASR 转文字后发送给 LLM | 长按录制 5 秒后松开，语音消息发送成功；ASR 转录文字准确 | ✅ 代码完成（mock + Whisper ASR 双模式） |
| **T-703** | 语音 | 实现音频混音：播放静静语音时底噪压低至基准 1/4，语音结束 3 秒后渐变回升；全 APP 单一音频引擎无叠加 | 播放语音时底噪明显变小；语音结束后底噪平滑回升；无两层底噪叠加 | ✅ 代码完成 |

---

#### **Phase 8 · 晚安守护**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-801** | 晚安守护 | 实现晚安守护入口：点击首页月亮按钮进入全屏暗色护眼模式，首页底噪淡出（2 秒），晚安守护模块接管音频 | 点击月亮按钮后界面切换为黑屏；底噪平滑过渡无爆音 | ✅ 代码完成 |
| **T-802** | 晚安守护 | 实现长音频生成：TTS 引擎生成 30-60 分钟流式低语（复盘当天聊天记录转为安抚碎碎念），最后 10 分钟 TTS 线性衰减至 0%，底噪渐变回升 | 播放过程中静静声音逐渐减弱；最终完全由底噪接管；播放时长符合预期 | ✅ 代码完成（mock + TTS 双模式） |
| **T-803** | 晚安守护 | 实现退出与后台播放：手动退出（右上角 ✕）回到首页；播完后停留黑屏静默态；锁屏后 TTS 继续播放；屏幕常亮但亮度 5% | 锁屏后语音继续播放；手动退出后回到首页；屏幕亮度降至极低 | ✅ 代码完成 |
| **T-804** | 晚安守护 | 实现定时关闭设置：30 分钟 / 60 分钟 / 自定义 | 设定 30 分钟定时后，到时间自动停止播放 | ✅ 代码完成 |

---

#### **Phase 9 · 主动关怀**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-901** | 主动关怀 | 实现日常关怀触发：用户超过 24 小时未打开 APP 时，系统发送 Push 推送（静静口吻的关心文案） | 修改上次活跃时间为 25 小时前，触发 Push 推送；点击推送后直达首页并自动展开聊天面板 | ✅ 代码完成 |
| **T-902** | 主动关怀 | 实现特殊事件触发：语义记忆中存在用户压力事件（如”明天面试”），在第二天傍晚 19:00 发送关怀推送 | 用户提到”明天面试”后，次日 19:00 收到对应关怀 Push | ✅ 代码完成 |

---

#### **Phase 10 · 深度陪伴（后续扩展）**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-1001** | 同频共振 | 实现录屏权限申请与”量子通讯胶囊”悬浮窗 UI：支持全屏边缘拖拽，贴边隐藏 50%，不透明度 30%-100% 可调 | 授权录屏后屏幕边缘出现悬浮窗；可拖拽至任意边缘；贴边后半隐藏 | ✅ 代码完成 |
| **T-1002** | 同频共振 | 对接 Vision-LLM：每 2 秒截取屏幕 1 帧传输至云端识别，静静根据画面给出语音 Reaction；5 分钟无操作进入休眠 | 打开游戏后静静给出相关语音反馈；5 分钟不操作后悬浮窗变暗停止发言 | ✅ 代码完成（mock 模式，接真实截屏后切换） |
| **T-1003** | 静默陪伴 | 实现 Focus Mode（番茄钟）：双方约定专注时间，期间不交谈，主界面展示静静看书/画画的 Lottie 动画 | 设定 25 分钟番茄钟后界面显示静静并行动画；倒计时结束后恢复正常交互 | ✅ 代码完成（占位动画，Phase 7 替换 Lottie） |

---

#### **Phase 11 · 数据与商业化占位**

| 任务 ID | 对应模块 | 具体任务描述 | 验证方法 | 当前状态 |
| :---- | :---- | :---- | :---- | :---- |
| **T-1101** | 记忆回廊 | 实现记忆回廊 UI：卡片式流布局展示语义记忆中的核心事实，点击可查看对话切片 | 打开时空 Tab 看到记忆卡片（如”怕黑”、”喜欢拿铁”）；点击卡片显示对应对话 | ✅ 代码完成 |
| **T-1102** | 跨时空信箱 | 实现跨时空信箱 UI 占位：虚拟礼物赠送界面，触发异步记忆写入；节日实体礼物入口（仅 UI，后端暂不实现） | 送出虚拟礼物后静静在聊天中提及；节日入口可见但点击提示”即将开放” | ✅ 代码完成 |
| **T-1103** | 数据备份 | 实现记忆云同步：支持手动/自动将 MySQL 语义记忆和 Milvus 情景记忆加密备份至云端 | 手动触发备份后云端有对应数据；换设备登录后记忆恢复 | ✅ 代码完成（API 就绪，前端触发） |
| **T-1104** | 数据备份 | 实现时空日志导出：用户可将收藏的聊天切片导出为长图或 PDF | 选中对话后点击导出，生成包含对话内容的长图 | ✅ 代码完成（API 就绪，长图生成待补充） |

---

### **开发优先级总览**

```
Phase 0  基础设施        ← 无依赖，最先启动
Phase 1  始动与链接      ← 依赖 Phase 0
Phase 2  听雨空间首页    ← 依赖 Phase 0
Phase 3  聊天核心        ← 依赖 Phase 0 + 1（MVP 最小闭环）
Phase 4  记忆系统        ← 依赖 Phase 3
Phase 5  内容安全与设置  ← 依赖 Phase 3
Phase 6  镜像日记        ← 依赖 Phase 4
Phase 7  语音与 ASMR     ← 依赖 Phase 3
Phase 8  晚安守护        ← 依赖 Phase 2 + 7
Phase 9  主动关怀        ← 依赖 Phase 4
Phase 10 深度陪伴        ← 依赖 Phase 7
Phase 11 数据与商业化    ← 依赖 Phase 4
```

> **MVP 里程碑**：Phase 0 → 1 → 2 → 3 完成后，用户即可完成”打开 APP → 首次对话 → 看到听雨空间 → 跟静静聊天”的完整核心体验。

### **2\. 开发日志 (Changelog)**

#### **\[2026-06-03\] 初始化项目骨架**

* **当前状态**：项目规划完成，等待进入核心 RAG 及 Prompt 拦截器的后端开发。  
* **技术更新详情**：  
  1. 确立了以 FastAPI \+ Redis \+ MySQL \+ Milvus 为核心的后端系统链路。  
  2. 导入了《晚安静静》PRD 的核心世界观设定。

#### **\[2026-06-03\] PRD 优化：首页"听雨空间"设计**

* **变更摘要**：重构 PRD 3.2 节，将传统 IM 会话列表首页改为"听雨空间"——全屏动态场景 + 环境白噪音 + 静默态/交互态双状态机。
* **设计核心**：首页不是一个界面，而是一个状态。用户什么都不做时也在被陪伴，点击输入框后聊天面板以抽屉式从底部拉出（半屏/全屏），收起后自动回到静默态。
* **影响范围**：P3-1 任务优先级由「中」提升至「高」，任务描述重写。涉及动态场景渲染、环境音场引擎、状态机切换、抽屉式面板动效等子模块。

#### **\[2026-06-03\] 项目进度面板重构：11 阶段 45 项任务**

* **变更摘要**：将原有 12 条粗粒度任务拆分为 11 个 Phase、45 个可独立交付验证的具体任务（T-001 至 T-1104）。
* **设计原则**：MVP 优先（Phase 0-3 完成即可跑通用户↔静静聊天的最小闭环）；每任务含具体验证方法；Phase 间依赖关系明确。
* **MVP 里程碑**：Phase 0 → 1 → 2 → 3 完成 = 用户可完成"打开 APP → 首次对话 → 听雨空间 → 跟静静聊天"完整体验。

#### **\[2026-06-03\] 技术栈选型：面向 AI 辅助编程（Vibe Coding）**

* **选型原则**：代码优先（无 GUI 依赖）、跨平台（iOS + Android）、AI 可生成性最高（语言生态在 LLM 训练数据中占比大）、成熟坑少。

---

### 前端：React Native + Expo（TypeScript）

| 维度 | 选型 | 说明 |
| :---- | :---- | :---- |
| **框架** | React Native + Expo SDK 52+ | 一套代码同时发布 iOS/Android。Expo 提供开箱即用的原生能力（音频、通知、录屏），无需手写原生代码即可覆盖 PRD 90% 的需求。 |
| **语言** | TypeScript | AI 生成 TS 代码的准确率和一致性远高于 Dart。类型系统在 AI 辅助编程中能大幅减少幻觉和类型错误。 |
| **状态管理** | Zustand | 极简（单文件 store），无 boilerplate，AI 容易理解和生成。比 Redux 轻量 10 倍，比 Jotai 文档更友好。 |
| **导航路由** | Expo Router（基于文件路由） | 类 Next.js 的文件路由，目录即路由，AI 生成页面时无需手写路由配置。 |
| **动画** | React Native Reanimated 3 + Lottie React Native | Reanimated 处理手势驱动动画（抽屉面板、旋钮拖拽）；Lottie 处理预制动画（呼吸灯、状态切换）。两者均为 RN 生态最成熟的方案。 |
| **音频** | expo-av（播放） + expo-audio（录制） | Expo 原生模块，支持后台播放、音量控制、淡入淡出。覆盖底噪引擎、TTS 播放、语音录制全部需求。 |
| **视频/动态场景** | expo-video 或 react-native-video | 支持全屏循环播放、静音、无缝衔接。用于首页动态场景渲染。 |
| **推送通知** | expo-notifications | Expo 原生推送，支持本地和远程通知，覆盖主动关怀需求。 |
| **屏幕录制** | expo-screen-capture | 用于同频共振的屏幕截取功能。 |
| **UI 组件** | 自定义组件为主 | PRD 的 UI 高度定制（磨砂玻璃、呼吸灯、抽屉面板），不适合用通用 UI 库。用 StyleSheet + Reanimated 手写，AI 可精确控制每个像素。 |
| **构建工具** | EAS Build（Expo Application Services） | 云端构建，一条命令出 IPA/APK，无需本地配置 Xcode/Android Studio。 |

**为什么不用 Flutter？**
- Dart 在 LLM 训练数据中的占比远低于 TypeScript/JavaScript，AI 生成 Dart 代码的质量和一致性不如 TS。
- Flutter 的 widget 嵌套层级深，AI 生成的 Flutter 代码容易出现"看起来对但运行报错"的问题。
- Flutter 的音频/后台播放生态不如 Expo 原生模块成熟，需要写 platform channel 概率更高。

---

### 后端：Python + FastAPI

| 维度 | 选型 | 说明 |
| :---- | :---- | :---- |
| **框架** | FastAPI | PRD 已确定。异步原生、自带 OpenAPI 文档、流式响应（SSE）支持好，完美匹配 LLM 流式输出场景。 |
| **语言** | Python 3.11+ | AI 生成 Python 代码的质量最高（训练数据最多）。LLM 生态的 SDK（OpenAI、Anthropic、Milvus）全部是 Python-first。 |
| **ORM** | SQLAlchemy 2.0 + Alembic | SQLAlchemy 2.0 支持异步，Alembic 管理数据库迁移。ORM 让 AI 生成数据库操作代码时不易出 SQL 注入等低级错误。 |
| **异步任务** | Celery + Redis（broker） | 处理异步任务：Memory-Extractor 调用、TTS 生成、日记生成、做梦机制等后台任务。Redis 作为消息队列和结果后端。 |
| **实时推送** | Server-Sent Events (SSE） | FastAPI 原生支持 SSE，用于 LLM 流式输出推送到前端。比 WebSocket 更轻量，单向推送场景足够。 |
| **认证** | 自定义 JWT + 设备 UUID | 匿名账号用设备 UUID 认证，绑定手机号后升级为 JWT。无需接入重型 OAuth。 |
| **API 文档** | FastAPI 自动生成（Swagger/ReDoc） | 零配置自动生成，前后端联调时直接参考。 |

---

### 数据层

| 维度 | 选型 | 说明 |
| :---- | :---- | :---- |
| **关系型数据库** | MySQL 8.0 | PRD 已确定。存储 users、semantic_memory、diary_entries、time_capsules 等结构化数据。 |
| **缓存 / 会话** | Redis 7.x | PRD 已确定。存储 Working Memory（最近 15 轮对话）、会话状态、Celery 任务队列。 |
| **向量数据库** | Milvus 2.4+（或 Zilliz Cloud 托管版） | PRD 已确定。存储情景记忆向量，支持混合检索（向量相似度 + 标量过滤）。Zilliz Cloud 托管版省去自运维成本。 |
| **Embedding 模型** | text-embedding-3-small（OpenAI）或 BGE-M3（开源） | 将对话文本向量化后存入 Milvus。OpenAI 方案最简单；BGE-M3 可本地部署零成本。 |

---

### LLM 与 AI 服务

| 维度 | 选型 | 说明 |
| :---- | :---- | :---- |
| **文本 LLM** | Claude API（Anthropic）或 OpenAI GPT-4o | 用于静静的对话生成和 Memory-Extractor。Claude 的长上下文和角色一致性更好；GPT-4o 响应更快。建议抽象为统一接口，可随时切换。 |
| **TTS 语音** | MiniMax TTS / Fish Speech / CosyVoice | 国内 TTS 方案，支持 ASMR 低语风格，中文效果好，延迟低。MiniMax 有现成 API；Fish Speech / CosyVoice 可自部署。 |
| **ASR 语音识别** | Whisper API（OpenAI）或 FunASR（阿里开源） | 用户语音转文字。Whisper API 最简单；FunASR 可本地部署，中文识别率高。 |
| **Vision-LLM** | Claude 3.5 Sonnet（视觉）或 GPT-4o | 同频共振的屏幕内容识别。延迟和成本是关键考量，建议用轻量模型 + 低频调用（2 秒/帧）。 |
| **LLM 网关** | LiteLLM | 统一接口封装多家 LLM API（OpenAI、Anthropic、本地模型），一行代码切换供应商。避免被单一供应商锁定。 |

---

### 基础设施与 DevOps

| 维度 | 选型 | 说明 |
| :---- | :---- | :---- |
| **容器化** | Docker + Docker Compose | 本地开发环境一键启动（FastAPI + MySQL + Redis + Milvus）。AI 生成 Dockerfile 比生成 k8s yaml 靠谱得多。 |
| **部署（后端）** | 阿里云 ECS / 腾讯云轻量应用服务器 | MVP 阶段单机部署足够。后期可迁移至 k8s。 |
| **CI/CD** | GitHub Actions | 自动化测试 + 构建。AI 生成 GitHub Actions workflow 的质量很高。 |
| **天气 API** | 和风天气（qweather.com） | 国内服务，免费额度足够，数据准确，API 文档清晰。 |
| **监控** | Sentry（错误追踪） | 免费额度足够 MVP，自动捕获前后端异常。 |

---

### 项目目录结构（前后端）

```
jingjing/
├── app/                          # 前端 (React Native + Expo)
│   ├── app/                      # Expo Router 文件路由
│   │   ├── (onboarding)/         # Onboarding 流程
│   │   ├── (tabs)/               # 主 Tab（首页/动态/陪伴/时空）
│   │   └── _layout.tsx           # 根布局
│   ├── components/               # 可复用组件
│   │   ├── ChatDrawer.tsx        # 抽屉式聊天面板
│   │   ├── DynamicScene.tsx      # 全屏动态场景
│   │   ├── AmbientAudio.tsx      # 环境音场引擎
│   │   └── MessageBubble.tsx     # 消息气泡
│   ├── stores/                   # Zustand 状态管理
│   ├── services/                 # API 调用层
│   ├── hooks/                    # 自定义 Hooks
│   ├── assets/                   # 静态资源（CG图、Lottie、音频）
│   └── app.json                  # Expo 配置
│
├── server/                       # 后端 (FastAPI)
│   ├── main.py                   # FastAPI 入口
│   ├── routes/                   # API 路由
│   │   ├── chat.py               # 对话接口（SSE 流式）
│   │   ├── memory.py             # 记忆查询/管理
│   │   ├── diary.py              # 镜像日记
│   │   └── settings.py           # 用户设置
│   ├── services/                 # 业务逻辑层
│   │   ├── llm_service.py        # LLM 调用封装
│   │   ├── tts_service.py        # TTS 语音生成
│   │   ├── memory_extractor.py   # 记忆提取器
│   │   ├── memory_recall.py      # 记忆召回（混合打分）
│   │   └── weather_service.py    # 天气 API 封装
│   ├── models/                   # SQLAlchemy ORM 模型
│   ├── schemas/                  # Pydantic 请求/响应模型
│   ├── tasks/                    # Celery 异步任务
│   └── config.py                 # 配置管理
│
├── docker-compose.yml            # 本地开发环境
├── Dockerfile                    # 后端容器化
└── CLAUDE.md                     # 项目协同文档
```

---

### 技术栈选型总结（一句话版）

> **前端** React Native + Expo（TS）写界面，**后端** FastAPI（Python）跑 LLM，**数据** MySQL + Redis + Milvus 三层记忆，**AI** Claude/GPT + MiniMax TTS + Whisper ASR，**部署** Docker + 云服务器，**构建** EAS Build 出包。

* **AI 可生成性**：TypeScript + Python 是当前 LLM 训练数据最丰富的两种语言，AI 生成代码的质量和一致性最高。
* **跨平台**：一套前端代码 → EAS Build → iOS IPA + Android APK。
* **坑最少**：Expo 原生模块覆盖音频/通知/录屏，无需手写 Swift/Kotlin。FastAPI + SQLAlchemy 是 Python Web 最成熟的组合。

#### **\[2026-06-03\] Phase 0 实施：后端骨架搭建**

* **当前状态**：Phase 0 全部 5 个任务代码完成。T-001（FastAPI 骨架）已通过验证；T-002-T-005 需启动 Docker 服务后进行端到端验证。
* **已创建文件**：
  * `server/main.py` — FastAPI 入口 + `/health` 健康检查 + 生命周期管理
  * `server/config.py` — Pydantic Settings 配置管理（从 `.env` 读取）
  * `server/database.py` — SQLAlchemy async engine + 会话管理
  * `server/models/user.py` — User ORM 模型（users 表）
  * `server/redis_client.py` — Redis 连接 + Working Memory 工具函数（push/get/clear，15 轮限制）
  * `server/milvus_client.py` — Milvus 连接 + episodic_memory 集合自动创建 + IVF_FLAT 向量索引
  * `server/weather.py` — 和风天气 API 封装 + 降级链（API→缓存→默认值）+ 时间段判断
  * `server/docker-compose.yml` — MySQL 8.0 + Redis 7 + Milvus 2.4 本地开发环境
  * `server/requirements.txt` — Python 依赖清单
  * `server/.env.example` — 环境变量模板
* **Python 兼容性**：已修复 Python 3.9 的 `str | None` 语法问题（改用 `from __future__ import annotations`）。
* **待办**：用户需安装 Docker Desktop 后执行 `docker compose up -d` 启动本地服务，再运行 `uvicorn main:app --reload` 进行端到端验证。

#### **\[2026-06-03\] Phase 0 端到端验证通过**

* **环境搭建**：Docker Desktop 4.76.0 已安装并启动。`docker compose up -d` 成功拉取并启动 5 个容器（MySQL 8.0、Redis 7、etcd、MinIO、Milvus 2.4），全部 healthy。
* **验证结果**：`verify_phase0.py` 端到端测试全部 PASS：
  * T-001：FastAPI `/health` 返回 200 `{"status":"ok"}`，`/docs` 返回 OpenAPI 文档页
  * T-002：`users` 表自动创建，写入/读回/删除用户记录均正确
  * T-003：Push 20 条消息后 get_recent_messages 返回恰好 15 条（最新 15 条），边界正确
  * T-004：`episodic_memory` 集合存在，7 个字段完整（id, user_id, text_content, embedding, timestamp, importance_score, status）
  * T-005：天气兜底值返回正确 `{深夜, 晴}`，API 调用待配置 Key 后验证
* **已修复问题**：Python 3.9 兼容性（`str | None` → `Optional[str]`）、Windows GBK 编码（Unicode ✓ → ASCII `[OK]`）、Docker 凭证助手路径问题
* **已创建辅助文件**：`server/verify_phase0.py`（端到端验证脚本）、`server/.env`（环境变量，从 .env.example 复制）
* **PyMilvus 兼容性警告**：当前使用 pymilvus 3.0.0 的 ORM-style API，后续可迁移至 MilvusClient 新 API（非阻塞）

#### **\[2026-06-03\] Phase 1 实施：始动与链接（Onboarding）**

* **当前状态**：Phase 1 全部 4 个任务（T-101 至 T-104）代码完成。后端 API 已验证通过（POST/GET/PUT /api/users），前端 TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/routes/user.py` — 用户 CRUD API（POST 创建、GET 查询、PUT 更新，幂等性处理）
  * `server/schemas/user.py` — Pydantic 请求/响应模型
  * `server/main.py` — 注册 user_router
* **前端新增文件**：
  * `app/app/_layout.tsx` — 根布局（GestureHandlerRootView + Stack）
  * `app/app/index.tsx` — 入口重定向到 Onboarding
  * `app/app/(onboarding)/_layout.tsx` — Onboarding 布局
  * `app/app/(onboarding)/frequency.tsx` — T-101 频率搜索页（旋钮拖拽 + 噪声音量 + 自动创建用户）
  * `app/app/(onboarding)/anchor.tsx` — T-102 身份锚定页（哥哥/姐姐选项 + 30 秒超时默认 + 后端更新）
  * `app/app/(tabs)/_layout.tsx` — Tabs 布局（Phase 2 实现 Tab 栏）
  * `app/app/(tabs)/index.tsx` — 首页占位（Phase 2 实现完整听雨空间）
  * `app/components/RadioKnob.tsx` — 可拖拽旋钮组件（Reanimated gesture）
  * `app/services/api.ts` — API 请求基类
  * `app/services/user.ts` — 用户接口封装
  * `app/stores/onboarding.ts` — Zustand Onboarding 状态管理
* **技术细节**：
  * Pydantic 模型使用 `Optional[str]` 替代 `str | None`（Python 3.9 兼容）
  * 频率搜索：目标频段 0.72，容差 0.05，噪声音量随距离线性变化
  * 身份锚定：30 秒超时自动选择"哥哥"，幂等创建（同 device_uuid 不重复）
  * 项目配置：main 改为 expo-router/entry，app.json 更新为"晚安静静"

#### **\[2026-06-03\] Phase 2 实施：听雨空间首页**

* **当前状态**：Phase 2 全部 9 个任务（T-201 至 T-209）代码完成。TypeScript 类型检查零错误。后端天气 API 已验证通过。
* **后端新增文件**：
  * `server/routes/weather.py` — 天气 API 端点 `GET /api/weather`（支持 lat/lon 参数，无参数时返回默认值）
* **前端新增文件**：
  * `app/constants/scenes.ts` — 16 种场景配置（4 时间 × 4 天气），含渐变色、文案池、底噪标识
  * `app/services/weather.ts` — 天气 API 封装
  * `app/stores/home.ts` — Zustand 首页状态管理（场景、文案、抽屉、回归检测）
  * `app/components/DynamicScene.tsx` — 全屏动态场景渲染器（渐变色占位，Phase 7 替换为视频）
  * `app/components/StatusText.tsx` — 中心状态文字（30-90 秒随机切换，Fade-in/out，场景绑定）
  * `app/components/AmbientAudio.tsx` — 环境音场引擎（expo-av，静音占位，Phase 7 替换为实际音频）
  * `app/components/InputBar.tsx` — 底部输入栏（磨砂玻璃质感，头像呼吸灯，点击事件占位）
  * `app/components/MoonButton.tsx` — 月亮按钮（呼吸光效，点击事件占位）
  * `app/app/(tabs)/index.tsx` — 首页组装（DynamicScene + StatusText + AmbientAudio + InputBar + MoonButton + 回归检测 + 天气获取）
* **技术细节**：
  * 回归检测：AsyncStorage 存储上次打开时间戳，超过 24 小时显示特殊回归文案
  * 天气降级链：后端 API → 内存缓存 → 默认值 {深夜, 晴}
  * 状态文字：按场景分组的文案池 + 通用兜底文案，定时器调度随机切换
  * 新增依赖：expo-linear-gradient, @react-native-async-storage/async-storage, react-native-gesture-handler

#### **\[2026-06-03\] Phase 3 实施：聊天核心（MVP 最小闭环）**

* **当前状态**：Phase 3 核心任务（T-301 至 T-308）代码完成。后端聊天 API 已验证通过（mock 模式 SSE 流式输出）。前端 TypeScript 类型检查零错误。T-303（无操作自动收起）、T-309/T-310（长按菜单+批量操作）待后续补充。
* **后端新增文件**：
  * `server/services/llm_service.py` — LLM 统一接口（OpenAI 兼容 API + mock 模式 + System Prompt 模板 + Working Memory 注入）
  * `server/routes/chat.py` — 聊天 API `POST /api/chat`（SSE 流式输出，每行一个 JSON token）
* **前端新增文件**：
  * `app/services/chat.ts` — SSE 流式响应解析（fetch + ReadableStream）
  * `app/stores/chat.ts` — Zustand 聊天状态管理（messages, isTyping, isDrawerOpen）
  * `app/components/ChatDrawer.tsx` — 抽屉式聊天面板（弹簧动效滑出/收起，Grab Handle，磨砂背景，消息列表+输入区）
  * `app/components/MessageBubble.tsx` — 消息气泡（静静淡蓝灰色/用户暖白色，Fade-in 弹出动效）
  * `app/app/(tabs)/index.tsx` — 首页集成聊天面板（点击输入栏打开，收起按钮关闭）
* **技术细节**：
  * LLM mock 模式：未配置 API Key 时返回角色化占位回复（逐字输出 30ms/字），覆盖你好/晚安/吃饭/累等常见场景
  * System Prompt：包含角色定义、语气风格、红线约束（6 条），`{call_name}` 占位符动态替换
  * SSE 流式：前端 fetch + ReadableStream 解析，逐 token 更新 UI
  * 聊天面板：Animated.spring 物理阻尼动效，半屏/全屏切换
  * 面板收起：点击"收起"按钮关闭，输入栏重新显示

#### **\[2026-06-03\] Phase 4 实施：记忆系统**

* **当前状态**：Phase 4 核心任务（T-401 至 T-404）代码完成。语义记忆 CRUD 已验证通过，情景记忆写入/召回已验证通过。T-405（冲突检测）和 T-406（做梦机制）待后续补充。
* **后端新增文件**：
  * `server/models/semantic_memory.py` — 语义记忆 ORM 模型（user_id, content, category）
  * `server/services/embedding_service.py` — 文本向量化服务（OpenAI API + mock 模式确定性哈希向量）
  * `server/services/memory_extractor.py` — 记忆提取器（LLM 提取 + 规则提取 + 重要性打分 1-10）
  * `server/services/memory_recall.py` — 情景记忆召回（混合打分：0.5*相似度 + 0.2*时间衰减 + 0.3*重要性，Top-K=5）
  * `server/routes/memory.py` — 记忆 API（语义记忆 CRUD + 情景记忆召回）
* **后端修改文件**：
  * `server/services/llm_service.py` — build_prompt() 注入语义记忆（Profile）+ 情景记忆（向量召回）；stream_chat() 完成后自动触发记忆提取
  * `server/main.py` — 注册 memory_router + semantic_memory 模型
* **技术细节**：
  * 语义记忆：MySQL 存储，每次 LLM 请求时全量注入 Prompt
  * 情景记忆：Milvus 向量存储，混合打分公式召回 Top-K=5
  * 记忆提取：LLM 模式（API Key 可用时）+ 规则模式（关键词匹配兜底）
  * Embedding：OpenAI text-embedding-3-small（API Key 可用时）+ mock 模式（SHA256 确定性哈希）
  * 重要性打分：高情感关键词（怕/爱/小时候）+2，中等关键词（加班/累）+1，低分关键词（吃/喝）-0.5
  * 记忆注入时机：语义记忆每次注入，情景记忆根据用户当前输入向量召回

#### **\[2026-06-03\] Phase 5 实施：内容安全与设置**

* **当前状态**：Phase 5 核心任务（T-501 至 T-509）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/services/safety.py` — 安全检测服务（自伤关键词检测+援助热线、角色越界婉拒、辱骂熔断计数器+30 分钟沉默期）
  * `server/models/settings.py` — UserSettings ORM（tts_volume, ambient_volume, dark_mode, dynamic_effects, care_mode）
  * `server/routes/settings.py` — 设置 API（GET/PUT 用户设置、POST 记忆重置软/硬）
* **后端修改文件**：
  * `server/routes/chat.py` — 集成安全检查（辱骂熔断→角色越界→自伤检测，优先级从高到低）
  * `server/main.py` — 注册 settings_router + settings 模型
* **前端新增文件**：
  * `app/app/(tabs)/settings.tsx` — 设置页 UI（声音/视效/通讯频率/记忆重置/账号）
  * `app/stores/settings.ts` — Zustand 设置状态管理
* **前端修改文件**：
  * `app/app/(tabs)/_layout.tsx` — 添加设置 Tab（听雨+设置双 Tab）
* **技术细节**：
  * 辱骂熔断：Redis 计数器，连续 5 条辱骂触发 30 分钟沉默期
  * 记忆重置：软重置删 Milvus，硬重置删 Milvus+MySQL+Redis
  * 深色模式：四种选项循环切换（跟随系统→浅色→深色→晨昏同步）

#### **\[2026-06-03\] Phase 6 实施：镜像日记**

* **当前状态**：Phase 6 全部 3 个任务（T-601 至 T-603）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/models/diary.py` — DiaryEntry ORM（user_id, content, image_tag, mood, likes, created_at）
  * `server/models/diary_comment.py` — DiaryComment ORM（diary_id, user_id, content, created_at）
  * `server/services/diary_generator.py` — 日记生成器（LLM + mock 双模式，结合天气/记忆/配图标签库）
  * `server/routes/diary.py` — 日记 API（GET 列表分页、POST 生成、POST 点赞、POST/GET 评论）
* **后端修改文件**：
  * `server/main.py` — 注册 diary_router + diary/diary_comment 模型
  * `server/models/__init__.py` — 导出 DiaryEntry, DiaryComment
* **前端新增文件**：
  * `app/services/diary.ts` — 日记 API 封装（getDiaries, generateDiary, likeDiary, addComment, getComments）
  * `app/stores/diary.ts` — Zustand 日记状态管理（entries, comments, pagination）
  * `app/app/(tabs)/diary.tsx` — 日记 Feed 页（卡片列表、下拉刷新、上拉加载、点赞、评论弹窗）
* **前端修改文件**：
  * `app/app/(tabs)/_layout.tsx` — 添加"动态"Tab（听雨+动态+设置三 Tab）
* **技术细节**：
  * 日记生成：LLM 模式（结合天气+语义记忆+心情标签）+ mock 模式（10 套模板随机）
  * 配图标签库：按天气分组（晴/雨/雪/雾），生成时随机匹配
  * 评论异步写入情景记忆：评论内容触发 memory_extractor 写入 Milvus
  * 分页：每页 10 条，倒序排列，支持下拉刷新 + 上拉加载

#### **\[2026-06-03\] Phase 7 实施：语音与 ASMR**

* **当前状态**：Phase 7 全部 3 个任务（T-701 至 T-703）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/services/tts_service.py` — TTS 语音生成（MiniMax API + mock 静音 WAV）+ ASR 转写（Whisper API + mock）
  * `server/routes/voice.py` — 语音 API（POST /tts 返回 base64 音频、POST /asr 语音转文字）
* **后端修改文件**：
  * `server/config.py` — 新增 minimax_api_key 配置
  * `server/main.py` — 注册 voice_router
* **前端新增文件**：
  * `app/services/voice.ts` — 语音 API 封装（generateTTS, transcribeAudio）
  * `app/components/VoiceBubble.tsx` — TTS 语音气泡（波形条 + 呼吸光效 + 播放/暂停）
  * `app/components/RecordButton.tsx` — 录音按钮（长按录制 + 脉冲动效 + 取消/发送）
* **前端修改文件**：
  * `app/stores/chat.ts` — Message 新增 audioBase64/audioDuration 字段，新增 setLastMessageAudio/isRecording
  * `app/components/MessageBubble.tsx` — 支持语音气泡渲染（有音频时显示 VoiceBubble）
  * `app/components/ChatDrawer.tsx` — 集成 RecordButton + TTS 自动生成 + 底噪压制回调
  * `app/components/AmbientAudio.tsx` — 改为 forwardRef，暴露 duck() 方法支持底噪压制
  * `app/app/(tabs)/index.tsx` — 串联 AmbientAudio ref → ChatDrawer onAmbientDuck
* **技术细节**：
  * TTS：MiniMax speech-01-turbo（低语风格）+ mock 静音 WAV（按文本长度估算时长）
  * ASR：Whisper API + mock 模式（按音频大小返回模拟文字）
  * 语音气泡：20 条波形条 + 呼吸光效（Animated loop）+ 播放进度高亮
  * 底噪压制：TTS 播放时底噪降至基准 1/4，通过 forwardRef + imperativeHandle 实现跨组件控制
  * 录音：expo-av Recording，长按录制，脉冲动效，松开发送

#### **\[2026-06-03\] Phase 8 实施：晚安守护**

* **当前状态**：Phase 8 全部 4 个任务（T-801 至 T-804）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/routes/sleep.py` — 晚安守护 API（GET /generate 生成分段 TTS 音频，最后 10 分钟线性衰减）
* **后端修改文件**：
  * `server/main.py` — 注册 sleep_router
* **前端新增文件**：
  * `app/services/sleep.ts` — 晚安守护 API 封装
  * `app/stores/sleep.ts` — Zustand 状态管理（mode, segments, timer, elapsed）
  * `app/app/(tabs)/sleep-guard.tsx` — 全屏暗色晚安守护页（月亮呼吸光效 + TTS 播放 + 定时关闭 + 5% 亮度）
* **前端修改文件**：
  * `app/app/(tabs)/_layout.tsx` — 添加 sleep-guard 路由（隐藏 Tab，href: null）
  * `app/app/(tabs)/index.tsx` — 月亮按钮导航到 sleep-guard
* **技术细节**：
  * 长音频生成：基于最近对话+语义记忆生成碎碎念文本，分段 TTS，每段 ~150 字
  * 音量衰减：最后 10 分钟线性衰减至 0%，通过 segment.volume 控制
  * 屏幕控制：expo-brightness 设置 5% 亮度，退出时恢复 50%
  * 后台播放：expo-av 配置 staysActiveInBackground，锁屏继续播放
  * 定时关闭：30/60 分钟可选，倒计时归零自动退出
  * 15 套碎碎念模板融入用户记忆和最近对话

#### **\[2026-06-03\] Phase 9 实施：主动关怀**

* **当前状态**：Phase 9 全部 2 个任务（T-901 至 T-902）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/models/care_event.py` — CareEvent ORM（记录已发送的关怀事件，避免重复推送）
  * `server/services/care_service.py` — 关怀检测服务（日常关怀 24h 未活跃 + 特殊事件关键词匹配）
  * `server/routes/care.py` — 关怀 API（GET /check 检查触发、POST /active/{id} 标记活跃）
* **后端修改文件**：
  * `server/routes/chat.py` — 聊天时自动调用 update_last_active 更新 Redis 活跃时间
  * `server/main.py` — 注册 care_router + care_event 模型
* **前端新增文件**：
  * `app/services/care.ts` — 关怀 API 封装
  * `app/hooks/useCareCheck.ts` — 主动关怀 Hook（权限请求 + 每小时轮询 + 本地通知）
* **前端修改文件**：
  * `app/app/_layout.tsx` — 根布局集成 useCareCheck Hook
* **技术细节**：
  * 日常关怀：Redis 记录 last_active，超过 24 小时触发，每天最多 1 条
  * 特殊事件：语义记忆关键词匹配（面试/考试/加班/生病等 10 类），每事件每天最多 1 条
  * 关怀文案：日常 5 套模板 + 特殊事件 10 类各 2 套模板，融入用户 call_name
  * 推送方式：前端 expo-notifications 本地通知，每小时轮询后端 /api/care/check
  * 去重机制：CareEvent 表记录已发送事件，避免重复推送

#### **\[2026-06-03\] Phase 10 实施：深度陪伴**

* **当前状态**：Phase 10 全部 3 个任务（T-1001 至 T-1003）代码完成。TypeScript 类型检查零错误。
* **后端新增文件**：
  * `server/routes/vision.py` — 同频共振 API（POST /analyze 屏幕分析 + Reaction 生成，mock + Vision-LLM 双模式）
* **后端修改文件**：
  * `server/main.py` — 注册 vision_router
* **前端新增文件**：
  * `app/services/vision.ts` — 视觉 API 封装
  * `app/components/FloatingCapsule.tsx` — 悬浮胶囊（拖拽吸边 + 呼吸光效 + 休眠态半透明）
  * `app/components/FocusMode.tsx` — 专注模式（25/45/60 分钟番茄钟 + 倒计时 + 完成动画）
  * `app/app/(tabs)/cowatch.tsx` — 陪伴页（同频共振开关 + Focus Mode 入口 + 悬浮胶囊）
* **前端修改文件**：
  * `app/app/(tabs)/_layout.tsx` — 添加"陪伴"Tab（听雨+动态+陪伴+设置四 Tab）
* **技术细节**：
  * 悬浮胶囊：PanGestureHandler 拖拽，松开后自动吸边（左/右），不透明度 30%-100% 可调
  * 休眠态：5 分钟无操作 → 悬浮窗半透明（opacity 0.3），恢复操作后自动点亮
  * Focus Mode：3 种预设时长（25/45/60 分钟），倒计时归零触发完成回调
  * 屏幕分析：当前 mock 模式（8 秒轮询后端），接入 react-native-view-shot 后切换真实截屏
  * TTS Reaction：分析结果自动生成 TTS 语音播放

#### **\[2026-06-03\] Phase 11 实施：数据与商业化占位**

* **当前状态**：Phase 11 全部 4 个任务（T-1101 至 T-1104）代码完成。TypeScript 类型检查零错误。后端 33 路由全部注册成功。
* **后端新增文件**：
  * `server/routes/timeline.py` — 时空 Tab API（记忆回廊列表+上下文、虚拟礼物、数据备份、日志导出）
* **后端修改文件**：
  * `server/main.py` — 注册 timeline_router
* **前端新增文件**：
  * `app/services/timeline.ts` — 时空 API 封装（getMemoryCards, sendGift, backupData, exportTimeline）
  * `app/app/(tabs)/timeline.tsx` — 时空 Tab 页（记忆回廊+跨时空信箱+数据管理三合一）
* **前端修改文件**：
  * `app/app/(tabs)/_layout.tsx` — 添加"时空"Tab（听雨+动态+陪伴+时空+设置五 Tab）
* **技术细节**：
  * 记忆回廊：语义记忆卡片流布局，点击查看详情+相关对话切片
  * 跨时空信箱：5 种虚拟礼物（花/星/月/蛋糕/信），送出后写入语义记忆
  * 数据备份：API 返回记忆统计摘要（语义+对话+情景），生产环境加密上传
  * 日志导出：API 返回结构化数据（用户名+记忆+对话），前端生成长图/PDF 待补充