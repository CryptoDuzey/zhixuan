# 可选本地混合检索

从 `work/rag_engine.py`、`rag_server.py`、`rag_answer.py` 整理的独立模块。普通资料读取不需要安装本模块。源码不附带知识库、模型、索引、密钥、评估题或已标注答案；测试只生成虚构资料。

## 环境与配置

从仓库根目录运行命令。使用已经准备好依赖的 Python 环境，直接依赖版本见本目录的 `requirements.txt`。整理时环境为 Python 3.13.8；已离线验证 NumPy、SciPy、scikit-learn 的实际导入，未验证全新环境安装或不同平台的安装包可用性。本次没有联网安装依赖。

| 环境变量 | 含义 |
| --- | --- |
| `ZHIXUAN_KB_DIR` | 必填。独立取得且获授权的完整知识库目录，须与资料读取程序使用同一目录。 |
| `ZHIXUAN_EMBEDDING_MODEL` | 必填。已完整准备的本地 SentenceTransformer 模型目录；不会下载模型。 |
| `ZHIXUAN_RAG_STORE` | 可选。索引、断点进度和访问日志目录；默认 `app/data/private/rag`，不随当前工作目录变化。 |
| `IMA_RAG_PORT` | 可选。查询端口，默认 `8766`，范围 `1–65535`。 |
| `IMA_RAG_HEALTH_PORT` | 可选。独立健康检查端口，默认 `8767`，不能与查询端口相同。 |
| `IMA_RAG_MAX_WORKERS` | 可选。查询并发上限，默认 `8`，范围 `1–32`。 |

显式提供的相对路径按命令执行目录解析。缓存目录不能放在 `scripts/` 下，也不能与知识库或模型互相包含。缓存内含原文片段，须作为私有数据保管。Windows 链接、目录联接和符号链接不参与知识库索引，与现有资料读取程序一致；模型目录须使用不含链接的完整本地副本。

原代码使用 `BAAI/bge-small-zh-v1.5`。本模块保留其中文查询前缀与 512 token 上限；提供同一模型最便于复现。换用其他本地模型时须自行核验此前缀、向量质量及阈值适用性。构建签名包含知识库全部文件的内容指纹、模型全部文件的内容指纹、分块数与索引版本；更换模型或修改资料后必须重建。模型加载强制离线、CPU 推理、禁止远程代码。

PowerShell 配置示例（占位路径应替换为自己的目录）：

```powershell
$env:ZHIXUAN_KB_DIR = 'D:/authorized-knowledge'
$env:ZHIXUAN_EMBEDDING_MODEL = 'D:/local-models/bge-small-zh-v1.5'
# 不设置 ZHIXUAN_RAG_STORE 即使用 app/data/private/rag。
```

离线构建与单次检索：

```powershell
python -B scripts/rag/rag_engine.py build
python -B scripts/rag/rag_engine.py query --q '要查的问题' --strategy hybrid --top-k 5
```

也支持 `python -B -m scripts.rag.rag_engine`。构建与查询需要本地依赖和真实模型；`--help`、导入模块和标准库配置/协议测试不加载模型。构建可续传，但不要同时运行多个构建，也不要在服务使用索引时覆盖索引；应停止服务、构建完成后重新加载。旧 `work/rag-index` 不会自动复用，需在新配置下重新构建。源码不读取旧的 `rag-config.json` 或评估产生的排序参数。

## HTTP 与资料读取程序的约定

首次整理阶段只完成离线测试，真实服务启动曾收到工具的 `blocked by policy` 拒绝。2026-10-19在用户重新明确要求恢复运行后，已使用本地真实资料重建新版索引，真实模型已离线加载成功，8766/8767已启动，8765实际转发混合查询已返回50条结果。最新服务状态、性能限制与实际HTTP验收结果以 `docs/知识库运行说明.md` 为准；历史拒绝不表示当前服务仍被阻塞。正常启动命令为：

```powershell
python -B scripts/rag/rag_server.py
# 为资料读取程序配置：
$env:ZHIXUAN_RAG_BASE = 'http://127.0.0.1:8766'
```

两个监听地址均固定为 `127.0.0.1`，没有对外绑定选项；服务类也会拒绝其他主机名或地址。主查询端口支持：

| GET 路径 | 参数与行为 |
| --- | --- |
| `/health` | 返回完整知识库绑定和运行状态。 |
| `/search` | `q` 必填，最多 1000 字；`top_k` 为 `1–50`，默认 10；`strategy` 可为 `exact`、`lexical`、`vector`、`hybrid`，默认 hybrid。 |
| `/answer` | `q` 同上，`top_k` 默认 5；固定 hybrid，不接受 `strategy`。回答由来源完整原句摘录组成。 |

独立健康端口仅支持 `/health`；查询槽位满时仍可探测进程状态。它与主端口一样会重新扫描资料，扫描耗时取决于全库大小。2026-10-19真实1522文件健康扫描约5.8–6.1秒；当前性能复验见运行说明。健康可探测不代表查询有空闲槽位，见 `querySaturated`。

保留现有资料读取程序所需约定：

- 健康状态包含 `service: "ima-local-rag"`、`files`、`fingerprint`、`ready`、`indexStale`。
- 全库指纹覆盖所有普通文件，包括图片和其他二进制文件；使用相对路径与文件 SHA-256，按 JavaScript UTF-16 顺序排列，并保留 Python JSON 的间隔格式。新增、删除、改动任意文件均失效；失效状态保持到重建并重启。
- 搜索与回答包含 `strategy`、`indexFingerprint`、`results`、`onlineUsed: false`；文档编号是相对路径 SHA-256 前 24 位，引用保留路径、文件校验值、片段和位置。
- 每次搜索和回答先完整扫描全部文件、计算内容指纹，成功响应携带 `verifiedSnapshot`：`service: "ima-local-rag"`、`apiVersion: 2`、`files`、`fingerprint`、`ready`、`indexStale`、`verification: "full-content-per-request"`。资料读取程序直接核验此绑定，避免查询前再做一次健康全扫；显式 `/rag/health` 仍独立全扫。绑定缺失、不是本次完整扫描、文件数或指纹不符时拒绝结果，旧版引擎须一同更新。没有引入内容校验缓存或延长默认超时。
- 混合检索片段使用原始换行；exact 与回答保留原 Python 通用换行行为，位置单位为 Unicode 码点。现有资料读取程序负责核对并转换到原文件位置。本模块的离线测试直接调用其原有校验函数验证该行为。
- 回答保留 `schemaVersion: 2`、`answered / clarify / insufficient_evidence`、`claims`、`conditions`、`citations`、`answerType: "extractive"`、`generationModelUsed: false`。缺依据、数值前提不符、来源冲突或变化时不输出未核实事实。
- 参数错误返回 400，未知接口 404，写入方法 405，来源失效 409，地址超长 414，并发已满 503（带 `Retry-After: 1`）。错误包含请求编号及空引用；日志只记录路由类别、耗时和状态，不记录问题、原文或完整地址。

本次保留了原有华为产品别名、主题识别和资料卡筛选规则。通用搜索可查任意正文；保守问答依赖原有目录分类和“已确认事实”“限定条件”“待核验项”等标题，并不是任意资料格式均可直接问答。图片只索引路径，不识别图片内容。相似度不代表事实概率；本轮真实HTTP仅做既有标注的小样本回归，不是独立盲评。

## 离线检验

```powershell
python -B -m unittest discover -s scripts/rag/tests -v
```

测试不加载真实模型，不读取真实知识库。一般测试禁止创建 Python socket；4项HTTP边界测试例外，仅启动随机本机端口，使用临时虚构资料与替代引擎，结束后关闭服务。配置、请求校验、内存中的处理器、文件变动、引用和来源冲突测试只使用标准库；真实索引写入、BM25 与矩阵排序测试使用已安装数值依赖及确定性假向量；Node.js 只执行离线指纹计算和从现有资料读取程序提取的校验函数，不导入或执行其启动入口。数值依赖或 Node.js 缺失时，对应测试会明确跳过；符号链接实际测试可能因 Windows 权限跳过。

上述临时资料测试不覆盖真实知识库跨进程HTTP、真实模型检索质量与真实并发负载。2026-10-19恢复运行的追加实测单独记于 `docs/知识库运行说明.md`，不与隔离测试混计。访问日志和索引只写入配置的私有缓存目录，发布时不要附带这些内容。
