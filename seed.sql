-- 种子数据：与主页内置示例一致，保证接通后页面观感不变。
-- 可重复执行（tools/site 冲突跳过，feed 按文本去重）。
-- 日常修改请走 /api/admin/* 接口或直接 UPDATE，不必重跑本文件。

INSERT INTO tools (slug, name, category, one_liner, sort, links_json, media_json, qa_json, updated_ts) VALUES
('lumenvox', 'LumenVox', 'Voice',
 '把 60 秒清唱变成可商用的多语种配音与音色克隆，保留气声与情绪起伏。',
 1, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"需要准备什么?","answer":"一段 60 秒以上、背景干净的清晰人声即可开始克隆。"},{"question":"支持多少语言?","answer":"中、英、日、韩等 22 种语言，可跨语种保留同一音色。"},{"question":"能商用吗?","answer":"可用于商业配音，并附可追溯的音色来源说明。"}]',
 1757000000000),
('frameforge', 'FrameForge', 'Video',
 '从一段文字脚本自动生成带分镜、运镜与配乐的短视频初稿，一键导出成片。',
 2, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"输入什么?","answer":"粘贴一段文字脚本或要点，自动拆分镜与镜头。"},{"question":"出片要多久?","answer":"常见 30–60 秒短片，几分钟内得到带配乐的初稿。"},{"question":"能改吗?","answer":"分镜、运镜、配乐都可逐条重生成后再导出。"}]',
 1757000000000),
('cortex-chat', 'Cortex Chat', 'RAG',
 '接入你的私有知识库，给出带引用来源、可追溯原文的精准问答。',
 3, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"接哪些数据?","answer":"支持 PDF、Markdown、Notion、网页与数据库等私有知识源。"},{"question":"回答可信吗?","answer":"每条答案带引用来源，可一键跳转原文核对。"},{"question":"数据安全吗?","answer":"支持私有部署，知识库不外传，权限按人隔离。"}]',
 1757000000000),
('palette-diffusion', 'PaletteDiffusion', 'Image',
 '用一张品牌参考图，扩散出整套风格一致的视觉物料与配色体系。',
 4, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"需要几张参考图?","answer":"一张品牌主视觉即可起步，参考越多风格越稳。"},{"question":"一致性如何?","answer":"锁定配色与版式，批量产出海报、封面与社媒物料。"},{"question":"能换风格吗?","answer":"可微调参考权重或叠加第二参考，快速切换风格。"}]',
 1757000000000),
('codepilot-x', 'CodePilot X', 'Dev',
 '读懂整个仓库的上下文，在 IDE 里直接完成重构、写测试并开 PR。',
 5, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"能读多大项目?","answer":"解析整仓索引，理解跨文件的依赖与团队约定。"},{"question":"产出是什么?","answer":"直接给出可运行 diff、测试与 PR 说明。"},{"question":"安全吗?","answer":"支持本地/私有模型选项，代码不用于训练。"}]',
 1757000000000),
('insightboard', 'InsightBoard', 'Data',
 '用自然语言提问，秒级生成可下钻、可分享的交互式 BI 看板。',
 6, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"怎么提问?","answer":"用自然语言描述想看的数据，自动生成图表与 SQL。"},{"question":"能深挖吗?","answer":"支持点击下钻、维度筛选，并可保存分享看板。"},{"question":"连哪些数据源?","answer":"常见数据库、表格与 API，配置一次即可复用。"}]',
 1757000000000),
('musewrite', 'MuseWrite', 'Writing',
 '把零散素材与要点，整理成结构清晰的多版本长文与营销文案。',
 7, '[{"kind":"open","url":"#"}]', '[]',
 '[{"question":"从什么开始?","answer":"丢入零散要点、录音或素材，先生成结构大纲。"},{"question":"能几种版本?","answer":"一键生成多个语气/长度版本，方便对比挑选。"},{"question":"会编造吗?","answer":"基于你给的事实扩展，并标注需要核实之处。"}]',
 1757000000000)
ON CONFLICT(slug) DO NOTHING;

INSERT INTO site (key, value) VALUES
('brand_name', '舒狐 shufy'),
('contact_email', 'hi@shufy.ai')
ON CONFLICT(key) DO NOTHING;

INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'update', 'LumenVox 新增 3 种中文方言音色', 1, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = 'LumenVox 新增 3 种中文方言音色');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'news', '多模态模型上下文窗口突破百万 token', 2, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = '多模态模型上下文窗口突破百万 token');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'update', 'FrameForge 上线自动配乐库 v2', 3, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = 'FrameForge 上线自动配乐库 v2');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'soon', 'PaletteDiffusion 品牌套件内测招募中', 4, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = 'PaletteDiffusion 品牌套件内测招募中');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'news', '开源社区发布新一代语音克隆基座', 5, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = '开源社区发布新一代语音克隆基座');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'update', 'Cortex Chat 支持引用一键溯源跳转', 6, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = 'Cortex Chat 支持引用一键溯源跳转');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'news', '主流厂商下调推理 API 调用价格', 7, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = '主流厂商下调推理 API 调用价格');
INSERT INTO feed (type, text, sort, created_ts)
  SELECT 'update', 'InsightBoard 新增自然语言下钻分析', 8, 1757000000000
  WHERE NOT EXISTS (SELECT 1 FROM feed WHERE text = 'InsightBoard 新增自然语言下钻分析');
