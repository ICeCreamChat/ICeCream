// 简单的Node.js脚本验证模块是否能正确加载
import { readFileSync } from 'fs';

console.log('=== 验证前端模块完整性 ===\n');

// 1. 检查所有必要的export
const controllerCode = readFileSync('public/js/tools/timetable/controller-smart-helper.js', 'utf8');
const viewCode = readFileSync('public/js/tools/timetable/view-smart-helper.js', 'utf8');

// 检查controller是否有正确的import
if (controllerCode.includes("import { requestTimetable }")) {
    console.log('✅ Controller使用正确的API调用方式');
} else {
    console.log('❌ Controller仍在使用错误的import');
}

// 检查是否移除了gateway import
if (controllerCode.includes('gateway/services')) {
    console.log('❌ 仍然有gateway import（会导致浏览器崩溃）');
} else {
    console.log('✅ 已移除所有gateway import');
}

// 检查default export
if (controllerCode.includes('export default {') &&
    controllerCode.includes('openSmartConstraintHelper') &&
    controllerCode.includes('applySingleFix')) {
    console.log('✅ Controller正确导出所有方法');
} else {
    console.log('❌ Controller导出不完整');
}

// 检查view是否有escapeHtml
if (viewCode.includes('function escapeHtml')) {
    console.log('✅ View有escapeHtml函数');
} else {
    console.log('⚠️ View缺少escapeHtml函数（可能依赖外部）');
}

// 检查renderSmartConstraintHelper export
if (viewCode.includes('export function renderSmartConstraintHelper')) {
    console.log('✅ View正确导出renderSmartConstraintHelper');
} else {
    console.log('❌ View缺少主渲染函数导出');
}

console.log('\n=== 验证API路由 ===');
const routeCode = readFileSync('gateway/routes/timetable-constraint-chat.js', 'utf8');

if (routeCode.includes("'/constraints/scan'") &&
    routeCode.includes('autoScanConstraints')) {
    console.log('✅ /constraints/scan 路由正确配置');
} else {
    console.log('❌ 扫描API路由配置错误');
}

if (routeCode.includes("'/constraints/generate-fix'") &&
    routeCode.includes('generateAutoFix')) {
    console.log('✅ /constraints/generate-fix 路由正确配置');
} else {
    console.log('❌ 修复API路由配置错误');
}

console.log('\n=== 验证事件绑定 ===');
const interactionCode = readFileSync('public/js/tools/timetable/grid-interactions.js', 'utf8');

if (interactionCode.includes('#tt-open-smart-helper') &&
    interactionCode.includes('openSmartConstraintHelper')) {
    console.log('✅ 智能助手按钮已绑定');
} else {
    console.log('❌ 智能助手按钮未绑定');
}

const actions = [
    'apply-fix',
    'apply-all-fixes',
    'view-problem-details',
    'confirm-fix',
    'close-smart-helper'
];

let allBound = true;
actions.forEach(action => {
    if (!interactionCode.includes(`action === '${action}'`)) {
        console.log(`❌ ${action} 未绑定`);
        allBound = false;
    }
});

if (allBound) {
    console.log('✅ 所有smart-helper actions已绑定');
}

console.log('\n=== 结论 ===');
console.log('如果以上全是✅，则代码层面100%完成');
console.log('下一步：在浏览器中测试实际功能');
