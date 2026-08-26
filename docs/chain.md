如果你说的 **China Pool** 是指在 sing-box 中实现一套“国内节点池 / 国内直连池”，用于让指定域名经过一组中国大陆出口节点，同时其他流量保持 `direct`，可以设计成下面这种结构。

如果你指的是 **China Pool = 中国大陆节点作为链式代理中的某一层节点池**，下面的设计同样适用。

## 1. 整体结构

建议把配置拆成 4 个概念：

```text
China Pool
│
├── china-01
├── china-02
├── china-03
└── china-04
        │
        ▼
    urltest / selector
        │
        ▼
   china-pool
```

然后路由：

```text
x.com
   ↓
china-pool
   ↓
Internet

其他域名
   ↓
direct
```

如果进一步加入链式代理：

```text
x.com
  ↓
C-pool
  ↓
B
  ↓
A-pool
  ↓
Internet
```

---

# 2. 一个完整的 China Pool

下面使用 Trojan 作为示例节点类型。

```json
{
  "outbounds": [
    {
      "type": "trojan",
      "tag": "china-01",
      "server": "cn01.example.com",
      "server_port": 443,
      "password": "password-01"
    },
    {
      "type": "trojan",
      "tag": "china-02",
      "server": "cn02.example.com",
      "server_port": 443,
      "password": "password-02"
    },
    {
      "type": "trojan",
      "tag": "china-03",
      "server": "cn03.example.com",
      "server_port": 443,
      "password": "password-03"
    },

    {
      "type": "urltest",
      "tag": "china-pool",
      "outbounds": [
        "china-01",
        "china-02",
        "china-03"
      ],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "3m",
      "tolerance": 50
    },

    {
      "type": "direct",
      "tag": "direct"
    }
  ]
}
```

这样：

```text
china-pool
    │
    ├── china-01
    ├── china-02
    └── china-03
```

`urltest` 会从这些节点中选择符合测试策略的节点。

---

# 3. 让指定域名走 China Pool

加入 `route`：

```json
{
  "route": {
    "rules": [
      {
        "domain": [
          "x.com",
          "twitter.com",
          "api.x.com"
        ],
        "action": "route",
        "outbound": "china-pool"
      }
    ],

    "final": "direct"
  }
}
```

最终：

```text
                 ┌─ china-01
x.com ─→ china-pool ├─ china-02
                 └─ china-03

其他流量 ─────────────→ direct
```

---

# 4. China Pool 作为链式代理的一层

如果你的目标实际上是：

```text
A Pool → B → China Pool
```

可以这样：

```text
Internet
   ↑
China Pool
   ↑
B
   ↑
A Pool
   ↑
Client
```

配置：

```json
{
  "outbounds": [
    {
      "type": "trojan",
      "tag": "A-01",
      "server": "a01.example.com",
      "server_port": 443,
      "password": "xxx"
    },
    {
      "type": "trojan",
      "tag": "A-02",
      "server": "a02.example.com",
      "server_port": 443,
      "password": "xxx"
    },

    {
      "type": "urltest",
      "tag": "A-pool",
      "outbounds": [
        "A-01",
        "A-02"
      ],
      "url": "https://www.gstatic.com/generate_204"
    },

    {
      "type": "trojan",
      "tag": "B",
      "server": "b.example.com",
      "server_port": 443,
      "password": "xxx",
      "detour": "A-pool"
    },

    {
      "type": "trojan",
      "tag": "CN-01",
      "server": "cn01.example.com",
      "server_port": 443,
      "password": "xxx",
      "detour": "B"
    },
    {
      "type": "trojan",
      "tag": "CN-02",
      "server": "cn02.example.com",
      "server_port": 443,
      "password": "xxx",
      "detour": "B"
    },

    {
      "type": "urltest",
      "tag": "China-pool",
      "outbounds": [
        "CN-01",
        "CN-02"
      ],
      "url": "https://www.gstatic.com/generate_204"
    }
  ]
}
```

逻辑：

```text
Client
  │
  ▼
China-pool
  │
  ├── CN-01 ─┐
  └── CN-02 ─┤
             ▼
             B
             │
             ▼
           A-pool
          ┌──┴──┐
         A-01  A-02
```

实际可能产生：

```text
Client
 ↓
CN-02
 ↓
B
 ↓
A-01
 ↓
Internet
```

---

# 5. 但是这里有一个很重要的问题

如果你的目标是：

> **A Pool → B → C Pool**

需要特别注意 `urltest` 与 `detour` 的关系。

你希望的是：

```text
           A1
          ↗
Client → B → C1
          ↘
           C2
```

并且：

```text
A Pool
 ├── A1
 └── A2

C Pool
 ├── C1
 └── C2
```

最终希望自动产生：

```text
A1 → B → C1
A1 → B → C2
A2 → B → C1
A2 → B → C2
```

**这和简单地把多个 outbound 塞进 `urltest` 是两个不同的问题。**

`urltest` 的选择对象是 outbound。它不会天然帮你建立一个“所有层组合后再进行端到端测速”的矩阵。

如果你做的是代理客户端，建议把它抽象成：

```text
Node
Pool
Chain
Route
```

---

# 6. 推荐的配置模型

### Node

```json
{
  "tag": "cn-01",
  "type": "trojan",
  "server": "cn01.example.com",
  "server_port": 443,
  "password": "xxx"
}
```

### Pool

```json
{
  "tag": "china-pool",
  "type": "urltest",
  "outbounds": [
    "cn-01",
    "cn-02",
    "cn-03"
  ]
}
```

### Chain

```text
chain-x
│
├── layer 1
│   └── A-pool
│
├── layer 2
│   └── B
│
└── layer 3
    └── China-pool
```

### Route

```text
x.com
 ↓
chain-x
```

这样你的应用层完全可以不关心 sing-box 的 `detour` 细节。

---

# 7. 更适合 Satelite Proxy 的抽象

如果你准备把这个东西加入 Satelite Proxy，我会建议配置概念设计成：

```json
{
  "pools": [
    {
      "tag": "china",
      "nodes": [
        "cn-01",
        "cn-02",
        "cn-03"
      ],
      "strategy": "urltest"
    },
    {
      "tag": "japan",
      "nodes": [
        "jp-01",
        "jp-02"
      ],
      "strategy": "urltest"
    }
  ],

  "chains": [
    {
      "tag": "china-chain",
      "layers": [
        "china"
      ]
    },

    {
      "tag": "jp-chain",
      "layers": [
        "china",
        "japan"
      ]
    }
  ],

  "rules": [
    {
      "domain": [
        "x.com"
      ],
      "chain": "jp-chain"
    }
  ]
}
```

最终生成 sing-box：

```text
                    ┌── CN-01
                    ├── CN-02
x.com → Japan Pool ←┴── CN-03
          │
          ▼
       China Pool
```

如果你真正想做的是 **“China Pool”作为一种特殊的节点池：自动把国内 IP/国内域名/国内服务分配到国内节点，同时还能作为多级链路的一层**，那还需要把 **DNS、GeoIP、GeoSite、route、detour、urltest** 一起设计，否则单独做 Pool 很容易出现 DNS 走错、测速走错出口的问题。

