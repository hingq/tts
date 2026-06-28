# 基于 LangGraph 的小说转有声书 Agent 方案 (V2 架构优化版)

## 1. 核心系统拓扑

```text
               ┌──────────────────────────────────────────────┐
               │         Global State (Graph History)         │
               │  - Project ID   - Master Character Registry  │
               └──────────────────────┬───────────────────────┘
                                      │
                                      ▼
                             [ Chapter Splitter ]
                                      │
                                      ▼
                            [ Character Matcher ] ◄─── (Vector DB / Registry)
                                      │
                                      ▼
                        ┌─────────────┴─────────────┐
                        │   Chapter Sub-Graph       │
                        │                           │
                        │      [ Text Aligner ]     │
                        │             │             │
                        │             ▼             │
                        │     [ Script Director ]   │
                        │             │             │
                        │             ▼             │
                        │     [ Phoneme Fixer ]     │
                        │             │             │
                        │             ▼             │
                        │    [ Voice Allocator ]    │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        [ Human Review (Interrupt) ] ─── (Web Frontend)
                                      │
                                      ▼
                              [ TTS Generator ]
                                      │
                                      ▼
                                 [ QA Agent ]
                                 ┌────┴────┐
                              pass       fail
                                 │         │
                                 │         ▼
                                 │   (Rollback to Fixer/Director)
                                 ▼
                           [ Audio Merger ] ───► [ Publish ]

```

---

## 2. 状态矩阵设计 (State Management)

为了防止长篇小说导致 Token 爆量与上下文断层，系统采用**全局持久化状态**与**章节流转局部状态**的双层架构。

### 2.1 全局状态 (Global State)

- **项目元数据**：`project_id`、`novel_title`、`total_chapters`。
- **全局角色注册表 (Master Character Registry)**：
- 通过 LangGraph 的 `reducer` 实现动态增量合并。
- 存储全书已识别角色的核心画像：性别、年龄段（少年/青年/中年/老年）、性格标签、特征向量（Embedding，用于跨章节声纹与文本匹配）。
- **强绑定声音 ID (`voice_id`)**：一旦分配，全书通用，从根本上杜绝“声音漂移”。

### 2.2 章节局部状态 (Chapter Local State)

- **章节元数据**：`chapter_id`、`chapter_title`、`raw_content`（章节原文）。
- **本章活跃角色 (`active_characters`)**：仅从全局注册表中检索出本章登场的人物，按需注入上下文，降低 Token 消耗。
- **结构化脚本清单 (`script_manifest`)**：包含单句索引、说话人（旁白或具体角色）、严格对应原文、情绪标签、语速微调系数、以及 SSML 音素标注。
- **异常与重试**：`qa_errors`（异常日志）、`retry_count`（当前重试轮数）。

---

## 3. 演进后的 Agent 管道线 (Pipeline)

### 3.1 Character Matcher（角色匹配与提取器）

- **动态提取**：扫描当前章节，提取本章出现的角色及上下文关系。
- **向量去重**：将提取到的角色与全局注册表进行相似度匹配（例如：自动识别“张老三”与已有的“张三”是否为同一人），防止角色库无限膨胀。
- **人工介入挂起 (Interrupt)**：若发现高置信度的新关键角色，触发图中断，通知前端弹出 UI 供人工确认并试听、分配 `voice_id`。

### 3.2 Script Agent（两阶段拆解子图）

为彻底杜绝大模型在单次输出长 JSON 时“漏字、吞剧情、自行篡改润色”的致命缺陷，该模块拆分为两个独立节点串联：

- **节点 A：Text Aligner（文本对齐器）**
- **核心任务**：仅做**切片**与**说话人打标（Speaker Labeling）**。
- **硬性约束**：输出的结构化文本拼接后，必须与章节原文逐字对应，确保有声书“不漏字”。

- **节点 B：Script Director（情感导演）**
- **核心任务**：基于对齐后的切片脚本，结合上下文章节氛围与剧情走向，为每一句台词注入 `emotion`（如：悲伤、冷笑、窃窃私语）和 `speed_modifier`（语速控制系数系数）。

### 3.3 Phoneme Fixer（音素与多音字校正器）

- **核心痛点**：传统 TTS 极易在中文多音字（如：_“便宜行事”_ 中的 _便宜_ 读 biàn yí 还是 pián yi）、生僻字、特定语气词上翻车。
- **工程实现**：利用“前置规则引擎（如 g2pW） + 大模型后置校验”双重审查机制扫描脚本。对于高危词汇，直接将其转换为包含拼音或 `<phoneme>` 标签的 **SSML（语音合成标记语言）**，抹平前端合成瑕疵。

### 3.4 TTS Generator（高低成本路由网关）

- **去 Agent 化**：该节点不引入大模型推理，纯粹作为异步工具链（Tool Call）执行。
- **成本路由策略**：
- **低成本路由**：识别到旁白（`speaker == "narrator"`）或平淡对白，路由至低成本、高稳定的普通 TTS（如 OpenAI TTS / Edge-TTS）。
- **高质量路由**：识别到核心主角（`speaker == "主角"`）且情绪处于剧烈波动（`emotion == "intense"`），路由至高表现力的 Expressive TTS（如 ElevenLabs / Cartesia）。

### 3.5 QA Agent（自动化质量审查与回滚机制）

- **闭环审查**：
- **字数与内容比对**：通过语音识别（ASR）对生成的音频进行反向转写，与结构化脚本中的原文进行字位对齐比对，检查是否存在漏读、错读。
- **声纹一致性校验**：抽取音频切片的声纹特征特征向量，校验同一角色在不同切片中的声纹是否发生畸变。

- **LangGraph 回滚路由（Conditional Edge）**：若 ASR 发现某句话存在严重漏读或多音字错误，QA Agent 将错误信息写入状态，将控制流向**条件导向回滚**至 `Phoneme Fixer` 或 `Script Director` 节点进行局部重新生成。设置最大重试阈值，失败则挂起报警。

---

## 4. 增强版技术栈推荐

| 模块            | 推荐选型                         | 选用理由                                                                                                         |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **状态与编排**  | **LangGraph + Temporal**         | LangGraph 负责微观 Agent 决策与局部状态机；Temporal 负责管理长达数天的人工审核挂起、分布式事务隔离与长任务重试。 |
| **底层存储**    | **PostgreSQL (pgvector)**        | 存储全局角色库（Character Registry）的特征向量，方便跨章节进行快速的角色分身检索。                               |
| **前端交互**    | **Next.js + WebSocket**          | 承载 Human-in-the-loop 的实时中断流。当 Agent 挂起时，前端向用户推流语音切片供人工“试听/重录/微调”。             |
| **多音字/音素** | **g2pW (Python / 规则库)**       | 基于 BERT 的中文多音字字音转换，准确率极高，作为大模型前置与后置的强校验工具。                                   |
| **音频拼接**    | **AudioSegment / FFmpeg Stream** | 在内存中完成 Audio Buffer 的无缝拼接，减少高频磁盘 I/O 带来的性能开销。                                          |

---

## 5. 三阶段演进路线

### 🚀 Phase 1：安全流水线 (MVP)

- **目标**：打通 `Text Aligner` -> `Voice Allocator` -> `TTS` -> `Audio Merger`。
- **核心指标**：确保全书**不漏字、不串音、角色声音绝对绑定**，验证长篇状态管理的稳定性。

### 🎨 Phase 2：智能导演与纠错机制

- **目标**：引入 `Phoneme Fixer`（彻底解决多音字）与 `QA Agent` 的自动重试回滚。
- **核心指标**：上线前端 Human-in-the-loop 交互面板，允许人工在后台对某一句不完美的 AI 配音进行个性化语调微调并一键局部重刷。

### 🎬 Phase 3：全自动 AI 影视级制片厂

- **目标**：引入智能背景音乐（BGM）与环境音效（SFX）的自动合成 Agent。
- **核心指标**：系统能够根据文本的情感曲线，自动在对白背景中混入雨声、脚步声或打斗声，支持多角色声音重叠（Overlap）的高级音频渲染，从“有声书”升级为“全景声广播剧”。
