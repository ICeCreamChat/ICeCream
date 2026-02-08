/**
 * ICeCream Solver - Configuration
 * Ported from MathSolver
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 */

import 'dotenv/config';

export const CONFIG = {
    siliconflow: {
        apiKey: process.env.SILICONFLOW_API_KEY,
        url: process.env.SILICONFLOW_API_BASE
            ? `${process.env.SILICONFLOW_API_BASE}/chat/completions`
            : 'https://api.siliconflow.cn/v1/chat/completions',
        model: 'Qwen/Qwen2.5-VL-72B-Instruct'
    },
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        url: process.env.DEEPSEEK_API_BASE
            ? `${process.env.DEEPSEEK_API_BASE}/chat/completions`
            : 'https://api.deepseek.com/v1/chat/completions',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    },
    mineru: {
        url: process.env.MINERU_URL || 'https://mineru.net',
        apiKey: process.env.MINERU_API_KEY,
        enabled: process.env.MINERU_ENABLED === 'true'
    }
};

export const MOCK_DATA = {
    mineru: {
        success: true,
        text: `已知：在 $\\triangle ABC$ 中，$AB = AC$，$D$ 是 $BC$ 的中点，$E$ 是 $AD$ 上一点。

求证：$BE = CE$

提示：可利用等腰三角形的性质和全等三角形判定。`,
        latex: '\\triangle ABC, AB = AC, D \\in BC, BD = DC'
    },
    siliconflow: {
        description: `图中是一个等腰三角形ABC，其中：
- 点A在上方，点B和C分别在左下和右下
- AB和AC两条边相等，用小短线标记表示
- D是BC边的中点，有中点标记
- E是AD线段上的一点
- 连接了BE和CE两条线段
- AD是三角形的高（或中线），与BC垂直相交于D点`
    },
    deepseek: {
        answer: `**第一步：模型判断**

这是一道典型的 **等腰三角形性质应用** + **全等三角形证明** 问题。

---

**第二步：解题思路**

由于 $AB = AC$ 且 $D$ 是 $BC$ 的中点，可以利用等腰三角形"三线合一"的性质：
- 顶角平分线
- 底边中线  
- 底边上的高

三者重合。因此 $AD \\perp BC$。

然后通过证明 $\\triangle BDE \\cong \\triangle CDE$ 来得出 $BE = CE$。

---

**第三步：详细步骤**

**证明：**

∵ $AB = AC$，$D$ 是 $BC$ 的中点

∴ $AD$ 是等腰三角形 $ABC$ 底边上的中线

∴ $AD \\perp BC$（等腰三角形三线合一）

∴ $\\angle ADB = \\angle ADC = 90°$

又 ∵ $E$ 在 $AD$ 上

∴ $\\angle BDE = \\angle CDE = 90°$

在 $\\triangle BDE$ 和 $\\triangle CDE$ 中：

$$
\\begin{cases}
BD = CD & \\text{（D是中点）} \\\\
\\angle BDE = \\angle CDE = 90° & \\text{（已证）} \\\\
DE = DE & \\text{（公共边）}
\\end{cases}
$$

∴ $\\triangle BDE \\cong \\triangle CDE$（SAS）

∴ $BE = CE$（全等三角形对应边相等）

**证毕。** ∎`
    }
};

export function isMockMode() {
    return !CONFIG.siliconflow.apiKey || !CONFIG.deepseek.apiKey;
}

export default { CONFIG, MOCK_DATA, isMockMode };
