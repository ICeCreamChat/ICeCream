/**
 * ICeCream - 常量配置模块
 * 集中管理所有魔术数字和配置项
 * Copyright (c) 2026 ICeCreamChat
 * 
 * 注意：此文件同时支持 ES6 模块和普通脚本加载
 */

// ================================
// 模式相关常量
// ================================
const MODE_HINTS = {
    auto: '自动模式 · 智能识别意图',
    chat: '聊天模式 · 与 AI 自由对话',
    manim: '动画模式 · 描述想要的动画',
    solver: '解题模式 · 上传题目或输入问题'
};

const MODE_LOADING_TEXTS = {
    auto: 'AI 正在分析中...',
    chat: 'AI 正在思考中...',
    manim: '正在生成动画代码...',
    solver: 'AI 正在解题中...'
};

const MODE_PLACEHOLDERS = {
    auto: '输入消息，或上传图片...',
    chat: '输入想聊的内容...',
    manim: '描述想要的动画，如：画一个正弦函数...',
    solver: '输入问题或上传题目图片...'
};

// ================================
// 粒子引擎配置
// ================================
const PARTICLE_CONFIG = {
    MATH_SYMBOLS: ['∑', '∫', 'π', '∞', '√', '≈', '≠', '±', '∂', '∇', 'x', 'y'],
    MATH_SYMBOLS_3D: ['∑', '∫', 'π', 'e', '0', '1', 'sin', 'cos', '∞', '√', 'tan', 'log'],
    COUNT_MOBILE: 1500,
    COUNT_DESKTOP: 3000,
    SPREAD_X: 400,
    SPREAD_Y: 300,
    SPREAD_Z: 200,
    RESET_Y: 150
};

// ================================
// UI 配置
// ================================
const UI_CONFIG = {
    MOBILE_BREAKPOINT: 768,
    MAX_HISTORY_MESSAGES: 50,
    MAX_SESSIONS: 20,
    TOAST_DURATION: 3000,
    RESIZE_DEBOUNCE: 100
};

// ================================
// 动画配置
// ================================
const ANIMATION_CONFIG = {
    EXPLOSION_PARTICLE_COUNT: 12,
    EXPLOSION_VELOCITY_MIN: 60,
    EXPLOSION_VELOCITY_MAX: 120
};

// ================================
// 主题配置
// ================================
const THEME_CONFIG = {
    DAY_START_HOUR: 6,
    DAY_END_HOUR: 19
};

// ================================
// 暴露给 window (供非模块脚本使用)
// ================================
if (typeof window !== 'undefined') {
    window.MODE_HINTS = MODE_HINTS;
    window.MODE_LOADING_TEXTS = MODE_LOADING_TEXTS;
    window.MODE_PLACEHOLDERS = MODE_PLACEHOLDERS;

    window.CONSTANTS = {
        ...PARTICLE_CONFIG,
        ...UI_CONFIG,
        ...ANIMATION_CONFIG,
        ...THEME_CONFIG,
        MATH_SYMBOLS: PARTICLE_CONFIG.MATH_SYMBOLS,
        MATH_SYMBOLS_3D: PARTICLE_CONFIG.MATH_SYMBOLS_3D,
        PARTICLE_COUNT_MOBILE: PARTICLE_CONFIG.COUNT_MOBILE,
        PARTICLE_COUNT_DESKTOP: PARTICLE_CONFIG.COUNT_DESKTOP,
        PARTICLE_SPREAD_X: PARTICLE_CONFIG.SPREAD_X,
        PARTICLE_SPREAD_Y: PARTICLE_CONFIG.SPREAD_Y,
        PARTICLE_SPREAD_Z: PARTICLE_CONFIG.SPREAD_Z,
        PARTICLE_RESET_Y: PARTICLE_CONFIG.RESET_Y,
        MAX_CROP_DIMENSION: 2048,
        CROP_QUALITY: 0.9,
        PANEL_MIN_WIDTH: 300,
        PANEL_MIN_HEIGHT: 200
    };
}
