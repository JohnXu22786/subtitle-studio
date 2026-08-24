# subtitle-studio

面向 **dsh**（DeepSeek Harness，理念「一切皆是插件」）的多语言字幕翻译工作流插件。
负责 SRT/VTT 字幕的解析与生成、逐句 LLM 翻译（OpenAI 兼容接口，默认 DeepSeek）、双语字幕合并、
对齐校验，以及整个目录的批量处理。同时提供「dsh 工具（`ctx.tools`）+ 命令行（CLI）」双入口。

> `subtitle-studio` 是一套全新、自包含的实现：字幕解析器完全从零编写（不依赖任何重型字幕库），
> LLM 层原生支持 OpenAI 兼容 HTTP（默认 DeepSeek），也可接入 harness 的 `ctx.llm` 接缝；
> 输入输出全程 UTF-8。

---

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [作为 dsh bundle 接入](#作为-dsh-bundle-接入)
- [CLI](#cli)
- [配置](#配置)
- [术语表格式](#术语表格式)
- [库 / 服务 API](#库--服务-api)
- [测试](#测试)
- [限制](#限制)
- [许可证](#许可证)

## 功能特性

1. **解析与生成** —— 基于容错状态机的 SRT / WebVTT：
   - 接受缺失序号、缺失空行分隔、CRLF、UTF BOM（UTF-8 / UTF-16LE / UTF-16BE）；
   - 保留多行字幕文本与 VTT 的 identifier / settings 原文；
   - 对垃圾行、非法时间码行采取「跳过并记录问题」而非直接失败；
   - 输出恒为 UTF-8，往返写入逐毫秒保真。

2. **逐句翻译** —— 按字符预算分批请求、以帧序号为键的 JSON 载荷保证一一对应；
   对瞬时错误限次重试（JSON 畸形时附纠正提示重试）、超时控制、术语表注入。
   兼容任意 OpenAI 兼容端点（默认 DeepSeek），或使用 dsh 的 `ctx.llm` 接缝。

3. **双语字幕** —— 合并原文与译文，支持 *上下行*（译文排在原文之下）或 *交错*（逐帧交替）两种版式，
   可加行级标签与分隔行。时间轴自源文件逐毫秒复制，天然精确保真。

4. **对齐校验** —— 逐一检查：译文条数 vs 源条数、缺失帧、多余帧、空译文、超长句（建议拆分）、时间轴重叠。

5. **批量处理** —— 整目录翻译：有界并发池、逐文件退避重试、原子检查点文件（断点续传）、token / 成本估算
   （内置近似单价，可用参数覆盖）。

6. **双入口** —— 5 个 dsh 工具（`sub_parse`、`sub_translate`、`sub_merge`、`sub_export`、`sub_glossary`），
   外加完整 CLI。

## 安装

要求 Node.js ≥ 18.18。

```bash
# 1. 安装开发依赖并构建
npm install
npm run build

# 2. 直接运行 CLI
node bin/subtitle-studio.js --help

# 或全局链接（之后可直接使用 subtitle-studio 命令）
npm link
```

本包**零运行时依赖**；TypeScript 仅为开发依赖（用 `tsc` 构建到 `lib/`）。

## 作为 dsh bundle 接入

本包是符合规范的 dsh **bundle**：`package.json` 声明 bundle 清单，
`cordis.patch.yml` 向 profile 注入插件行，`lib/index.js` 导出 Cordis 风格入口
（`name` + `apply(ctx, config)`）。

### 1. 将 bundle 加入某个 profile

```bash
dsh plugin --profile <name> add subtitle-studio
```

该命令安装本包，并把 `subtitle-studio` 追加到 profile 的 `dsh.profile.bundles`。
profile 加载器随后应用本 bundle 内置的 `cordis.patch.yml`，插入一行：

```yaml
- insert:
    - id: subtitle-studio
      name: subtitle-studio
      config:
        targetLanguages: []
        sourceLanguage: ''
```

### 2. 插件注册的内容

- **工具** —— 注册到 `ctx.tools`（在 `tools` 服务就绪时注册）：

  | 工具              | 作用                                                              |
  | ----------------- | ----------------------------------------------------------------- |
  | `sub_parse`       | 把字幕文件解析为结构化帧（JSON 输出）                              |
  | `sub_translate`   | 把字幕文件翻译为一个或多个语言（会调用 LLM）                       |
  | `sub_merge`       | 合并源字幕与翻译载荷（上下行 / 交错）                              |
  | `sub_export`      | 把字幕导出为 SRT 或 VTT（UTF-8），可选先做双语合并                  |
  | `sub_glossary`    | 管理 JSON 术语表（list / add / remove / merge）                    |

- **服务** `subtitleStudio`（当 `ctx.provide` 存在时），暴露
  `parse`、`translate`、`merge`、`validate`、`glossary`、`cost`、`stringify`、`convert`，
  方便其它插件直接调用库能力。

### 3. 插件配置

插件读取其 patch 行（以及 profile 覆盖）中的 `config` 对象。常用字段：

| 键                         | 类型                  | 默认值                          | 含义                                  |
| -------------------------- | --------------------- | ------------------------------- | ------------------------------------- |
| `llm.provider`             | `"openai"\|"dsh"`     | `"openai"`                      | HTTP 后端，或 harness `ctx.llm` 接缝  |
| `llm.baseUrl`              | string                | `https://api.deepseek.com/v1`   | OpenAI 兼容端点                       |
| `llm.apiKey`               | string                | —                               | API Key，支持 `${ENV_VAR}` 展开       |
| `llm.model`                | string                | `deepseek-chat`                 | 模型名                                |
| `llm.timeoutMs`            | number                | `120000`                        | 单次请求超时                          |
| `llm.maxRetries`           | number                | `2`                             | 瞬时失败重试次数                      |
| `llm.jsonMode`             | boolean               | `true`                          | 请求 JSON 对象响应                    |
| `llm.chunkChars`           | number                | `3500`                          | 每请求的字符预算                      |
| `sourceLanguage`           | string                | `""`（自动）                    | 源语言标签                            |
| `targetLanguages`          | string[]              | `[]`                            | 翻译目标语言                          |
| `glossary.paths`           | string[]              | `[]`                            | 术语表 JSON 文件（按序合并）          |
| `output.layout`            | `stacked\|interleaved` | `stacked`                      | 双语合并版式                          |
| `output.separator`         | string                | `""`                            | 原文块与译文块之间的分隔行            |
| `output.tagTarget`         | string                | —                               | 译文行级标签前缀                      |
| `output.format`            | `srt\|vtt`            | 跟随源格式                       | 输出容器格式                          |
| `output.utf8Bom`           | boolean               | `false`                         | 写出 UTF-8 BOM                        |
| `batch.concurrency`        | number                | `2`                             | 批量时的并发文件数                    |
| `batch.maxRetries`         | number                | `2`                             | 单文件重试次数                        |
| `batch.checkpoint`         | string                | `subtitle-studio.checkpoint.json` | 检查点路径                          |
| `validation.maxChars`      | number                | `160`                           | 中文超长句阈值                        |
| `validation.maxWords`      | number                | `40`                            | 西文超长句阈值                        |

在 profile 自己的 `cordis.patch.yml` 里覆盖一行 `config` 的示例（整体替换，见 dsh 补丁语义文档）：

```yaml
- id: subtitle-studio
  config:
    llm:
      provider: openai
      baseUrl: https://api.deepseek.com/v1
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
    sourceLanguage: en
    targetLanguages: [zh, ja]
    output:
      layout: stacked
```

> 想用 harness 自带的 LLM 提供方（例如已在 harness 中配置好的 DeepSeek 适配器），
> 将 `llm.provider` 设为 `dsh`，插件即调用 `ctx.llm.stream`。

### 4. 给 harness 作者的话

- 本入口**不 import** `@deepseek-ai/cordis`，对上下文做结构式访问，因此在有 / 无 harness
  的环境下同一份源码均可编译运行。需要强类型时，可自行
  `declare module '@deepseek-ai/cordis' { interface Context { subtitleStudio: ... } }`。
- 工具通过 `ctx.inject(['tools'], sub => …)` 延迟注册，即便在最小 profile 中也能启动；
  除非设置 `provider: dsh`，否则不会强依赖 `ctx.llm`。

## CLI

```
subtitle-studio <command> [options]
```

所有命令都支持 `--config <file.json>` 载入插件形态的配置，另有各命令专属参数（覆盖配置）。

### parse

```bash
subtitle-studio parse movie.srt
subtitle-studio parse movie.vtt --pretty       # 完整 JSON
```

### translate

```bash
# 单一目标语言 -> 双语（上下行）SRT
subtitle-studio translate movie.srt \
  --target zh --source en \
  --glossary glossary.json \
  --output movie.zh.srt

# 多目标语言 -> 命名为 <stem>.<target>.bilingual.<ext>
subtitle-studio translate movie.vtt --target zh --target fr --output movie.bilingual.vtt

# 交错版式 + 行级标签
subtitle-studio translate movie.srt --target zh --layout interleaved --tag "[zh] " --output out.srt

# 从环境变量读 API Key
subtitle-studio translate movie.srt --target zh --api-key ${DEEPSEEK_API_KEY} --output out.srt

# 运行中落盘中途检查点
subtitle-studio translate movie.srt --target zh --output out.srt --save-partial partial.json
```

流程：解析 → 时间轴校验 → 打印成本估算 → 翻译 → 对齐校验 → 合并 →
写出双语字幕 + `<name>.translation.json`。

### merge

```bash
# 从译文 JSON 文件
subtitle-studio merge movie.srt translation.json --layout interleaved --output merged.srt

# 或内联 JSON
subtitle-studio merge movie.srt '{"entries":[{"index":1,"text":"你好"}]}' --layout stacked
```

### export

```bash
# srt -> vtt，时间轴不变
subtitle-studio export movie.srt --output movie.vtt

# 双语导出
subtitle-studio export movie.srt --output movie.vtt --translation translation.json --layout interleaved
```

### validate

```bash
subtitle-studio validate movie.srt                    # 时间轴完整性与重叠
subtitle-studio validate movie.srt --compare translation.json  # 对照译文做对齐校验
subtitle-studio validate movie.srt --overlong         # 超长句报告
subtitle-studio validate movie.srt --no-overlap       # 跳过重叠检查
```

### glossary

```bash
subtitle-studio glossary list --path glossary.json
subtitle-studio glossary add --path glossary.json --source "DeepSeek Harness" --target "深度求索工具链" --scope zh
subtitle-studio glossary remove --path glossary.json --source "DeepSeek Harness"
subtitle-studio glossary merge --path glossary.json --with other.json
```

### batch

```bash
# 干跑：成本估算
subtitle-studio batch ./movies --output-dir ./out --target zh --estimate

# 实际运行：3 路并发 + 支持续传的检查点
subtitle-studio batch ./movies --output-dir ./out \
  --target zh --glossary glossary.json \
  --concurrency 3 --checkpoint cp.json --layout interleaved

# 中断后续传（跳过已完成，重试失败项）
subtitle-studio batch ./movies --output-dir ./out --target zh --checkpoint cp.json --resume
```

批次说明：
- 输出目录**镜像输入目录结构**，因此同名文件（如 `a/clip.srt` 与 `b/clip.srt`）永远不会互相覆盖
  （会写出 `out/a/clip.bilingual.srt` 与 `out/b/clip.bilingual.srt`）。
- 输出目录本身会被排除在扫描之外，批次不会重复翻译自己的产物（不会出现 `out/x.bilingual.bilingual.srt`）。
- `--resume` 会重新入队崩机时处于 `processing` 的文件、跳过 `done` 文件，
  并（在默认的 `--retry-failed` 下）以全新尝试额度重试 `failed` 文件。检查点在每个文件处理完后原子落盘。

### cost

```bash
subtitle-studio cost movie.srt --target zh
subtitle-studio cost ./movies --target zh --target fr --model deepseek-chat --rate-in 0.27 --rate-out 1.10
```

## 配置

CLI 与 dsh 插件共享同一份配置（见上文表格），通过 `--config` 或命令行参数传入。
API Key 可引用环境变量：

```bash
node bin/subtitle-studio.js translate a.srt --target zh --api-key "${env:DEEPSEEK_API_KEY}"
```

成本估算器内置的单价为按模型（`deepseek-chat`、`deepseek-reasoner`）给出的近似列表价，
始终可用 `--rate-in` / `--rate-out`（或对应配置项）覆盖。

## 术语表格式

术语表是一个 JSON 文档：

```json
{
  "name": "sample-glossary",
  "entries": [
    { "source": "DeepSeek Harness", "target": "深度求索工具链", "scope": "zh", "note": "官方产品名" },
    { "source": "hello", "target": "bonjour", "scope": "fr" },
    { "source": "bilingual", "target": "双语" }
  ]
}
```

- `source` → `target` 把源术语映射到强制使用的译文。
- `scope` 限定条目仅用于某个目标语言；无 `scope` 的条目对所有语言生效——这就是「一份术语表服务多种目标语言」。
- 翻译时，适用的条目会以「强制术语」的形式注入系统提示词。条目身份为 `(source, target, scope)`：
  同键 upsert 覆盖，异键并存。
- 参见 `examples/glossary.json`，可用 `subtitle-studio glossary list` 查看。

## 库 / 服务 API

公共入口 `lib/index.js` 直接导出各引擎函数：

```js
import {
  parseSubtitle, stringifySubtitle, convertSubtitle, detectFormat,
  translateCues, translateDocument,
  mergeBilingual, mergeWithEntries,
  validateSubtitle, validateTranslationAlignment,
  loadGlossaryFile, mergeGlossaries, buildGlossaryPrompt,
  createLlmClient, estimateCost,
} from 'subtitle-studio'
```

时间戳一律为整数毫秒；文件 I/O 一律 UTF-8。

## 测试

```bash
npm test
```

先 `tsc` 构建，再跑 Node 内置测试运行器对 `test/*.test.js` 执行（122 个测试，覆盖时间解析、
SRT/VTT 容错、编码/BOM、合并、校验、术语表、Mock HTTP 的翻译链路、批量/检查点，以及 dsh 工具与插件接口）。

## 限制

- token 计数为启发式；精准计费请用 `--rate-in / --rate-out`，所有成本打印仅作估算。
- 交错版式的双语输出会为两条帧复用完全相同的源时间码，因此重叠校验会将其标记——
  请对**源文档**做重叠检查，或在校验时排除双语文档。
- `jsonMode` 要求端点支持 `response_format`；若提供方以 HTTP 400 拒绝，客户端会自动去掉该字段重试。
- `dsh` LLM 提供方路径假定 harness `ctx.llm.stream` 的块结构；其它块结构会退化为通用文本抽取。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
