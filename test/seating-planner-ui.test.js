import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import seatingPlanner from '../public/js/tools/seating-planner.js';

const sourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);
const stylePath = new URL('../public/css/seating-planner.css', import.meta.url);
const launcherPath = new URL('../public/js/tools/app-launcher.js', import.meta.url);

test('seating planner exposes AI requirement entry instead of fixed layout controls', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /sp-arrange-prompt/);
  assert.match(source, /\/api\/tools\/seating\/arrange/);
  assert.match(source, /排座要求/);
  assert.match(source, /例如：两人一组，中间留过道，讲台旁安排左右护法，护法位置要一个成绩较差一个成绩较好的/);
  assert.match(source, />\s*生成座位表\s*</);
  assert.match(source, /btn\.innerHTML = '<i data-lucide="sparkles"><\/i> 生成座位表'/);
  assert.doesNotMatch(source, /AI 排座需求/);
  assert.doesNotMatch(source, />\s*AI 生成座位表\s*</);
  assert.doesNotMatch(source, /data-layout-template=/);
  assert.doesNotMatch(source, /id="sp-rows"/);
  assert.doesNotMatch(source, /id="sp-cols"/);
  assert.doesNotMatch(source, /sp-layout-prompt/);
});

test('seating planner has a large-grid virtual rendering guard', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /VIRTUAL_GRID_CELL_THRESHOLD/);
  assert.match(source, /renderVirtualGrid/);
  assert.match(source, /sp-grid--virtual/);
});

test('seating planner auto-fits wide grids horizontally without clipping seats', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const gridRule = styles.match(/\.sp-grid\s*{[^}]*}/s)?.[0] || '';

  assert.match(source, /fitGridToClassroomView\(\)\s*{/);
  assert.match(source, /this\.fitGridToClassroomView\(\);\s*this\.syncPodiumSeatWidth\(\);\s*this\.renderAisleGapHandles\(\);/s);
  assert.match(source, /this\._resizeHandler = \(\) => \{\s*this\.fitGridToClassroomView\(\);/s);
  assert.match(gridRule, /--sp-grid-fit-scale:\s*1/);
  assert.match(gridRule, /transform:\s*scale\(var\(--sp-grid-fit-scale,\s*1\)\)/);
  assert.match(gridRule, /transform-origin:\s*top left/);
});

test('seating planner positions aisle handles from scaled visible seat bounds', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /getVisibleGridSeatBounds\(\)/);
  assert.match(source, /const visualGridBounds = this\.getVisibleGridSeatBounds\(\)/);
  assert.match(source, /handle\.style\.left = `\$\{toLayerLeft\(visualGridBounds\.left\)\}px`/);
  assert.match(source, /handle\.style\.width = `\$\{visualGridBounds\.width\}px`/);
  assert.doesNotMatch(source, /handle\.style\.width = `\$\{gridRect\.width\}px`/);
});

test('seating planner shows clearer strategy labels and applied strategy status', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /搭配偏好/);
  assert.match(source, /身高照顾/);
  assert.match(source, /优秀优先/);
  assert.match(source, /appliedStrategies/);
});

test('seating planner surfaces the Timefold arrangement source in status', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /arrangementSource/);
  assert.match(source, /source: data\.source \|\| null/);
  assert.match(source, /Timefold 优化/);
  assert.match(source, /arrangementInterpretation/);
  assert.match(source, /explainButton\.id = 'sp-toggle-arrangement-explain'/);
  assert.match(source, /renderArrangementExplainPanel/);
  assert.match(source, /Timefold 负责学生分配，不改变布局列数/);
  assert.match(source, /sp-status-item--solver/);
  assert.match(styles, /\.sp-arrangement-explain/);
  assert.match(styles, /\.sp-status-item--solver/);
});

test('seating planner exposes a feedback entry before the tool theme toggle', async () => {
  const launcherSource = await readFile(launcherPath, 'utf8');
  const plannerSource = await readFile(sourcePath, 'utf8');
  const plannerStyles = await readFile(stylePath, 'utf8');

  const feedbackIndex = launcherSource.indexOf('tool-feedback-btn');
  const themeIndex = launcherSource.indexOf('tool-theme-toggle');
  assert.ok(feedbackIndex > -1, 'feedback button should exist in the tool header');
  assert.ok(themeIndex > -1, 'theme toggle should exist in the tool header');
  assert.ok(feedbackIndex < themeIndex, 'feedback button should be rendered before the theme toggle');
  assert.match(launcherSource, /tool\.id === 'seating'/);
  assert.match(launcherSource, /openFeedbackDialog/);
  assert.match(launcherSource, /const moduleVersion = encodeURIComponent\(window\.ICeCream\?\.assetVersion \|\| Date\.now\(\)\)/);
  assert.match(launcherSource, /import\(`\.\/\$\{tool\.module\}\.js\?v=\$\{moduleVersion\}`\)/);

  assert.match(plannerSource, /openFeedbackDialog/);
  assert.match(plannerSource, /buildFeedbackSnapshot/);
  assert.match(plannerSource, /recordDiagnosticEvent/);
  assert.match(plannerSource, /loadBackendDiagnostics/);
  assert.match(plannerSource, /\/api\/tools\/seating\/feedback/);
  assert.match(plannerSource, /\/api\/tools\/seating\/diagnostics/);
  assert.match(plannerSource, /diagnostics_request_failed/);
  assert.match(plannerSource, /反馈座位安排问题/);
  assert.match(plannerSource, /直接写您觉得哪里不对/);
  assert.match(plannerSource, /您希望它怎么做/);
  assert.doesNotMatch(plannerSource, /直接写你觉得哪里不对/);
  assert.doesNotMatch(plannerSource, /你希望它怎么做/);
  assert.match(plannerSource, /会附带脱敏座位快照，帮助我们复现问题/);
  assert.match(plannerStyles, /\.sp-feedback/);
  assert.match(plannerStyles, /\.sp-feedback-chip/);
});

test('seating feedback snapshot anonymizes names and keeps useful seating context', () => {
  seatingPlanner.students = [
    { id: 's01', name: '张三', gender: 'M', grade: 88, height: 171 },
    { id: 's02', name: '李四', gender: 'F', grade: 73, height: 160 },
  ];
  seatingPlanner._buildStudentMap();
  seatingPlanner.rows = 1;
  seatingPlanner.cols = 2;
  seatingPlanner.layout = [['s01', 's02']];
  seatingPlanner.guardians = ['s01', null];
  seatingPlanner.constraints = [{ type: 'avoid', target: '张三', related: '李四', reason: '不要相邻' }];
  seatingPlanner.strategy = { genderBalance: true, gradeStrategy: 'balance', heightOrder: false };
  seatingPlanner.arrangementStats = { solverUsed: true, solverName: 'Timefold Solver' };
  seatingPlanner.arrangementSource = 'timefold_solver';
  seatingPlanner.arrangementSpec = { groupSize: 2, groupsPerRow: 5 };
  seatingPlanner.arrangementInterpretation = { summary: '已理解为两人一组' };
  seatingPlanner.unassigned = [];
  seatingPlanner._diagnosticEvents = [];
  seatingPlanner._lastErrors = [];
  seatingPlanner.recordDiagnosticEvent('chat_noop', {
    student: 's01',
    message: 'Bearer live-secret-token',
    token: 'live-secret-token',
  });

  const snapshot = seatingPlanner.buildFeedbackSnapshot();
  const text = seatingPlanner.anonymizeFeedbackText('张三和李四没有按要求排开', snapshot.anonymizer);
  const serialized = JSON.stringify({ snapshot, text });

  assert.match(serialized, /stu_001/);
  assert.match(serialized, /stu_002/);
  assert.match(serialized, /80-89/);
  assert.match(serialized, /70-79/);
  assert.match(serialized, /170-179/);
  assert.match(serialized, /"diagnosticsVersion":2/);
  assert.match(serialized, /chat_noop/);
  assert.match(serialized, /arrangementSpec/);
  assert.match(serialized, /timefold_solver/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /张三|李四/);
  assert.doesNotMatch(serialized, /live-secret-token/);
  assert.equal(snapshot.layout[0][0], 'stu_001');
  assert.equal(snapshot.guardians.left, 'stu_001');
});

test('seating planner frames constraints as student seating needs in the UI', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /学生需求/);
  assert.match(source, /收集学生想坐哪里/);
  assert.match(source, /提取需求/);
  assert.match(source, /满足 \$\{evaluation\.satisfied\}\/\$\{evaluation\.total\} 需求/);
  assert.doesNotMatch(source, /AI 提取需求/);
  assert.doesNotMatch(source, /学生座位需求/);
  assert.doesNotMatch(source, /座位约束/);
  assert.doesNotMatch(source, /描述座位约束/);
});

test('seating planner lets teachers adjust extracted needs before arranging', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /renderConstraintsList\(\)/);
  assert.match(source, /toggleConstraintPriority\(index\)/);
  assert.match(source, /deleteConstraint\(index\)/);
  assert.match(source, /constraintPriorityTitle/);
  assert.match(source, /data-constraint-priority/);
  assert.match(source, /data-delete-constraint/);
  assert.match(source, /this\.constraints\[index\]\.priority = current === 'hard' \? 'soft' : 'hard'/);
  assert.match(source, /this\.constraints\.splice\(index,\s*1\)/);
  assert.match(source, /this\.refreshConstraintStatus\(\);\s*this\.updateStatus\(\);/s);
  assert.match(styles, /\.sp-constraint-actions/);
  assert.match(styles, /\.sp-constraint-priority\s*{[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.sp-constraint-delete/);
});

test('seating planner can show and hide seat grade and height details', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showSeatDetails/);
  assert.match(source, /sp-toggle-seat-details/);
  assert.match(source, /sp-seat-meta/);
  assert.match(source, /renderSeatMeta/);
});

test('seating planner disables the old hover personal-info tooltip', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.doesNotMatch(source, /tooltip\.className = 'sp-seat-tooltip'/);
  assert.doesNotMatch(source, /const tooltip = document\.createElement\('div'\);[\s\S]{0,240}sp-seat-tooltip/);
  assert.doesNotMatch(styles, /\.sp-seat--filled:hover\s+\.sp-seat-tooltip\s*{/);
  assert.match(source, /bindSeatDetailPopover\(cell,\s*student\.id\)/);
  assert.match(source, /showSeatDetailPopover\(event,\s*studentId\)/);
});

test('seating planner stacks desk status icons in the lower right corner', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const deskItemsRule = styles.match(/\.sp-desk-items\s*{[^}]*}/s)?.[0] || '';
  const booksRule = styles.match(/\.sp-desk-item--books\s*{[^}]*}/s)?.[0] || '';

  assert.match(deskItemsRule, /bottom:\s*4px/);
  assert.match(deskItemsRule, /right:\s*4px/);
  assert.match(deskItemsRule, /flex-direction:\s*column/);
  assert.match(deskItemsRule, /align-items:\s*flex-end/);
  assert.doesNotMatch(deskItemsRule, /left:/);
  assert.doesNotMatch(deskItemsRule, /justify-content:\s*space-between/);
  assert.doesNotMatch(booksRule, /margin-left:\s*auto/);
});

test('seating planner renders desk icons through one helper for normal virtual and guardian seats', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /renderDeskItems\(student\)/);
  assert.match(source, /createVirtualSeatCell\(r,\s*c\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(source, /renderGrid\(\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(source, /renderPodiumSeats\(\)[\s\S]*renderDeskItems\(student\)/);
  assert.match(source, /studentHasUnmetNeed\(student\.id\)/);
  assert.match(source, /studentHasSatisfiedNeed\(student\.id\)/);
  assert.match(source, /近视\|戴眼镜\|视力\|看不清\|看不见\|看不到\|黑板/);
  assert.doesNotMatch(source, /indicators\.some\(i => i\.reason\?\.includes\('视力'\)\)/);
});

test('seating planner opens a detailed popover when clicking assigned seats', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const popoverRule = styles.match(/\.sp-seat-detail-popover\s*{[^}]*}/s)?.[0] || '';
  const lightPopoverRule = styles.match(/body\.light-mode\s+\.sp-seat-detail-popover\s*{[^}]*}/s)?.[0] || '';

  assert.match(source, /buildSeatDetail\(studentId\)\s*{/);
  assert.match(source, /showSeatDetailPopover\(event,\s*studentId\)\s*{/);
  assert.match(source, /hideSeatDetailPopover\(\)\s*{/);
  assert.match(source, /syncSeatDetailPopoverPosition\(\)\s*{/);
  assert.match(source, /findSeatDetailAnchor\(studentId\)\s*{/);
  assert.match(source, /scheduleSeatDetailPopoverSync\(\)\s*{/);
  assert.match(source, /bindSeatDetailPopover\(cell,\s*studentId\)\s*{/);
  assert.match(source, /unbindSeatDetailPopover\(cell\)\s*{/);
  assert.match(source, /this\._seatDetailAnchor = null/);
  assert.match(source, /this\._seatDetailStudentId = null/);
  assert.match(source, /delete seat\.dataset\.studentId/);
  assert.match(source, /createVirtualSeatCell\(r,\s*c\)[\s\S]*bindSeatDetailPopover\(cell,\s*studentId\)/);
  assert.match(source, /renderGrid\(\)[\s\S]*bindSeatDetailPopover\(cell,\s*student\.id\)/);
  assert.match(source, /renderPodiumSeats\(\)[\s\S]*bindSeatDetailPopover\(seat,\s*student\.id\)/);
  assert.match(source, /this\._justDragged = true/);
  assert.match(source, /if \(this\._justDragged\) return/);
  assert.match(source, /addEventListener\('pointerup', cell\._seatDetailPointerUpHandler\)/);
  assert.match(source, /this\._seatDetailSuppressClickUntil = Date\.now\(\) \+ 220/);
  assert.match(source, /dx > 5 \|\| dy > 5 \|\| this\._justDragged/);
  assert.match(source, /studentHasVisionNeed\(student\.id\)/);
  assert.match(source, /isTopGradeStudent\(student\)/);
  assert.match(source, /studentHasSatisfiedNeed\(student\.id\)/);
  assert.match(source, /studentHasUnmetNeed\(student\.id\)/);
  assert.match(source, /keydown[\s\S]*Escape[\s\S]*hideSeatDetailPopover/);
  assert.match(source, /document\.addEventListener\('click', this\._seatDetailOutsideClickHandler\)/);
  assert.match(source, /document\.removeEventListener\('click', this\._seatDetailOutsideClickHandler\)/);
  assert.match(source, /anchor\.classList\.add\('sp-seat--detail-open'\)/);
  assert.match(source, /classList\.remove\('sp-seat--detail-open'\)/);
  assert.match(source, /document\.querySelectorAll\('\.sp-seat--filled\[data-student-id\]'\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => this\.syncSeatDetailPopoverPosition\(\)\)/);
  assert.match(source, /addEventListener\('scroll', this\._seatDetailScrollHandler/);
  assert.match(source, /removeEventListener\('scroll', this\._seatDetailScrollHandler/);
  assert.match(source, /window\.addEventListener\('resize', this\._seatDetailResizeHandler\)/);
  assert.match(source, /window\.removeEventListener\('resize', this\._seatDetailResizeHandler\)/);
  assert.match(source, /popover\.style\.left = `\$\{left\}px`/);
  assert.match(source, /popover\.style\.top = `\$\{Math\.max\(8,\s*top\)\}px`/);
  assert.doesNotMatch(source, /window\.scrollX/);
  assert.doesNotMatch(source, /window\.scrollY/);

  assert.match(styles, /\.sp-seat-detail-popover/);
  assert.match(popoverRule, /position:\s*fixed/);
  assert.match(popoverRule, /z-index:\s*10020/);
  assert.match(popoverRule, /--sp-seat-detail-bg:/);
  assert.match(popoverRule, /--sp-seat-detail-text:/);
  assert.match(popoverRule, /background:\s*var\(--sp-seat-detail-bg\)/);
  assert.match(popoverRule, /color:\s*var\(--sp-seat-detail-text\)/);
  assert.match(lightPopoverRule, /--sp-seat-detail-bg:\s*rgba\(255,\s*255,\s*255/);
  assert.match(lightPopoverRule, /--sp-seat-detail-text:\s*#0f172a/);
  assert.match(styles, /\.sp-seat-detail-header/);
  assert.match(styles, /\.sp-seat-detail-icons/);
  assert.match(styles, /\.sp-seat-detail-icon-row/);
  assert.match(styles, /\.sp-seat-detail-constraints/);
  assert.match(styles, /\.sp-seat-detail-popover--above/);
  assert.match(styles, /\.sp-seat-detail-popover--below/);
  assert.match(styles, /\.sp-seat--filled:hover,\s*\.sp-seat--detail-open\s*{[^}]*transform:\s*translateY\(-8px\)/s);
  assert.match(styles, /@keyframes spSeatDetailIn/);
});

test('seating planner marks books by top 20 percent grades instead of fixed score', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /getTopGradeStudentIds/);
  assert.match(source, /isTopGradeStudent/);
  assert.match(source, /Math\.ceil\(ranked\.length \* 0\.2\)/);
  assert.doesNotMatch(source, /student\.grade\s*&&\s*student\.grade\s*>=\s*90/);
  assert.doesNotMatch(source, /grade\s*>=\s*90/);
});

test('seating planner grade priority places only top 20 percent into best scored seats', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /placeTopGradeStudentsInBestSeats/);
  assert.match(source, /sortSeatsByScore/);
  assert.match(source, /getTopGradeStudentIds/);
  assert.match(source, /globalColumnCenter/);
  assert.doesNotMatch(source, /Grade priority: higher grade first/);
  assert.match(source, /height decides row, top 20% gets center seats inside that row/);
});

test('seating planner does not show arrangement notes as a second success warning toast', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showArrangementWarnings/);
  assert.doesNotMatch(source, /if \(arrangement\.warnings\.length\) this\.showToast\(arrangement\.warnings\.join\('；'\), 'warning'\)/);
});

test('AI seating assistant is styled as a draggable floating panel with mode toggle', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-chat-header"/);
  assert.match(source, /grip-vertical/);
  assert.match(source, /ICeCream 座位助手/);
  assert.match(source, /aria-label="打开 ICeCream 座位助手"/);
  assert.match(source, /aria-label="关闭 ICeCream 座位助手"/);
  assert.doesNotMatch(source, />AI 座位助手</);
  assert.match(source, /startChatDrag/);
  assert.match(source, /syncChatPosition/);
  assert.match(styles, /\.sp-chat--positioned/);
  assert.match(styles, /--sp-chat-left/);
  assert.match(styles, /cursor: grab/);
  assert.match(styles, /background: var\(--sp-bg-surface\)/);

  // Mode toggle
  assert.match(source, /id="sp-chat-mode"/);
  assert.match(source, /data-chat-mode="auto"/);
  assert.match(source, /data-chat-mode="micro"/);
  assert.match(source, /data-chat-mode="regenerate"/);
  assert.match(source, /setChatMode/);
  assert.match(styles, /\.sp-chat-mode/);
  assert.match(styles, /\.sp-chat-mode-btn/);
});

test('seating planner uses arrange completion without static prompt chips or chat autocomplete', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-arrange-completions"/);
  assert.match(source, /id="sp-arrange-completions" class="sp-autocomplete sp-autocomplete--above sp-hidden"/);
  assert.match(source, /id="sp-complete-arrange-prompt"/);
  assert.match(source, /补全要求/);
  assert.match(source, /completeArrangePrompt/);
  assert.match(source, /pickArrangeCompletion/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /setAttribute\('role', 'option'\)/);
  assert.match(source, /aria-controls="sp-arrange-completions"/);
  assert.match(source, /aria-expanded="false"/);
  assert.match(source, /\/api\/tools\/seating\/suggestions/);
  assert.match(source, /handleSuggestionKeyDown\(e, 'arrange'\)/);
  assert.match(source, /acceptSuggestion\(kind\)/);
  assert.match(source, /hideSuggestions\(kind\)/);
  assert.match(source, /renderSuggestionList\(kind\)/);
  assert.match(source, /clearSuggestionState\('arrange'\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\(\(\) => this\.requestSuggestions\(kind\), immediate \? 0 : 600\)/);
  assert.doesNotMatch(source, /sp-arrange-examples/);
  assert.doesNotMatch(source, /data-arrange-example/);
  assert.doesNotMatch(source, /applyArrangeExample/);
  assert.doesNotMatch(source, /id="sp-chat-completions"/);
  assert.doesNotMatch(source, /aria-controls="sp-chat-completions"/);
  assert.doesNotMatch(source, /handleSuggestionKeyDown\(e, 'chat'\)/);
  assert.doesNotMatch(source, /scheduleSuggestionRefresh\('chat'/);
  assert.doesNotMatch(source, /clearSuggestionState\('chat'\)/);
  assert.doesNotMatch(source, /kind === 'chat'/);
  assert.doesNotMatch(source, /target: 'chat'/);
  assert.doesNotMatch(source, /input\?\.addEventListener\('input', \(\) => this\.scheduleSuggestionRefresh\('chat'\)\)/);
  assert.doesNotMatch(source, /arrangePrompt\?\.addEventListener\('input', \(\) => this\.scheduleSuggestionRefresh\('arrange'/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.doesNotMatch(source, /sp-suggestion-strip/);
  assert.match(styles, /\.sp-autocomplete/);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*position: absolute/s);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*top: calc\(100% \+ 6px\)/s);
  assert.doesNotMatch(styles, /\.sp-autocomplete\s*{[^}]*margin-top/s);
  assert.match(styles, /\.sp-autocomplete--above\s*{[^}]*top: auto/s);
  assert.match(styles, /\.sp-autocomplete--above\s*{[^}]*bottom: calc\(100% \+ 8px\)/s);
  assert.doesNotMatch(styles, /\.sp-prompt-examples/);
  assert.doesNotMatch(styles, /\.sp-prompt-example/);
  assert.doesNotMatch(styles, /\.sp-autocomplete--chat\s*{[^}]*margin:/s);
  assert.match(styles, /\.sp-autocomplete-option/);
  assert.match(styles, /\.sp-autocomplete-option\.is-active/);
});

test('seating planner renders separate confirmation copy for batch tuning and regeneration', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /这会批量调整当前座位，但不改变布局，确认执行吗？/);
  assert.match(source, /这会重新生成座位表并可能大幅改变当前安排，确认继续吗？/);
  assert.match(source, /intent === 'batch_tune'/);
  assert.match(source, /intent === 'regenerate'/);
  assert.match(source, /guardians: this\.guardians/);
  assert.match(source, /this\.guardians = result\.guardians/);
  assert.doesNotMatch(source, /shouldUseArrangementAssistant/);
});

test('seating image import uses a review dialog before committing recognized students', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-image-review"/);
  assert.match(source, /识别结果确认/);
  assert.match(source, />\s*序号\s*<\/th>/);
  assert.match(source, /确认导入/);
  assert.match(source, /重新上传/);
  assert.match(source, /取消/);
  assert.match(source, /showImageReview\(result\.data/);
  assert.match(source, /confirmImageReview\(\)/);
  assert.match(source, /appendReviewedStudentsToInput/);
  assert.match(source, /sp-image-review-title/);
  assert.match(source, /识别结果确认（\$\{students\.length\}人）/);
  assert.match(source, /indexCell\.className = 'sp-image-review-index'/);
  assert.match(source, /indexCell\.textContent = String\(index \+ 1\)/);
  assert.doesNotMatch(source, /data-field="index"/);
  assert.match(styles, /\.sp-image-review/);
  assert.match(styles, /\.sp-image-review-index/);
  assert.match(styles, /\.sp-image-review-row--warning/);
  assert.match(styles, /\.sp-image-review-field--warning/);
});

test('student roster update opens the review-style editable table', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showStudentEditor\(text/);
  assert.match(source, /this\.showStudentEditor\(text\)/);
  assert.match(source, /this\.showStudentEditor\(this\.formatStudentsForEditor\(result\.data\.students\)\)/);
  assert.match(source, /this\.showStudentEditor\(nextText\)/);
  assert.match(source, />\s*编辑名单\s*</);
  assert.match(source, /addEventListener\('click', \(\) => this\.openRosterEditor\(\)\)/);
  assert.match(source, /openRosterEditor\(\)/);
  assert.match(source, /showRosterReview\(students/);
  assert.match(source, /名单编辑（\$\{students\.length\}人）/);
  assert.match(source, /confirmRosterReview\(\)/);
  assert.match(source, /applyRosterReviewUpdate/);
  assert.match(source, /confirmButton\.textContent = '确认更新'/);
  assert.match(source, /reuploadButton\?\.classList\.add\('sp-hidden'\)/);
  assert.doesNotMatch(source, /sp-parse-students'\)\?\.addEventListener\('click', \(\) => this\.parseStudents\(\)\)/);
});

test('student roster editor supports add, bulk append, and row removal controls', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /id="sp-roster-toolbar"/);
  assert.match(source, /id="sp-roster-add-row"/);
  assert.match(source, />\s*添加一行\s*</);
  assert.match(source, /id="sp-roster-bulk-toggle"/);
  assert.match(source, />\s*批量粘贴\s*</);
  assert.match(source, /id="sp-roster-bulk-text"/);
  assert.match(source, /id="sp-roster-bulk-append"/);
  assert.match(source, />\s*追加到表格\s*</);
  assert.match(source, /sp-roster-action-head/);
  assert.match(source, /sp-roster-delete-row/);
  assert.match(source, /addRosterReviewRow/);
  assert.match(source, /appendRosterBulkText/);
  assert.match(source, /toggleRosterBulkPanel/);
  assert.match(source, /renumberReviewRows/);
  assert.match(source, /setRosterEditorControlsVisible\(false\)/);
  assert.match(source, /setRosterEditorControlsVisible\(true\)/);
  assert.match(styles, /\.sp-roster-toolbar/);
  assert.match(styles, /\.sp-roster-bulk-panel/);
  assert.match(styles, /\.sp-roster-delete-row/);
});

test('student roster update preserves placed students and clears removed seats only', () => {
  seatingPlanner.students = [
    { id: 's01', name: '张三', gender: 'M', height: 170, grade: 80 },
    { id: 's02', name: '李四', gender: 'F', height: 165, grade: 90 },
    { id: 's03', name: '王五', gender: 'M', height: 171, grade: 70 },
  ];
  seatingPlanner._buildStudentMap();
  seatingPlanner.layout = [
    ['s01', 's02'],
    ['s03', null],
  ];
  seatingPlanner.guardians = ['s02', null];
  seatingPlanner.classroomLayout = {
    rows: 2,
    cols: 2,
    cells: [['seat', 'seat'], ['seat', 'seat']],
    groups: [[null, null], [null, null]],
    guardians: { enabled: true, left: 's02', right: null },
    template: 'custom',
    groupSize: 1,
  };
  seatingPlanner.unassigned = [];

  const update = seatingPlanner.buildRosterUpdateFromReview([
    { id: 's01', name: '张三', gender: 'M', height: 170, grade: 80 },
    { id: 's03', name: '王五', gender: 'M', height: 171, grade: 70 },
    { name: '赵六', gender: 'F', height: 160, grade: 88 },
  ]);

  assert.deepEqual(update.removedIds, ['s02']);
  assert.deepEqual(update.addedIds, ['s04']);
  assert.deepEqual(update.students.map(student => student.id), ['s01', 's03', 's04']);

  seatingPlanner.applyRosterReviewState(update);

  assert.equal(seatingPlanner.layout[0][0], 's01');
  assert.equal(seatingPlanner.layout[0][1], null);
  assert.equal(seatingPlanner.layout[1][0], 's03');
  assert.deepEqual(seatingPlanner.guardians, [null, null]);
  assert.equal(seatingPlanner.classroomLayout.guardians.left, null);
  assert.deepEqual(seatingPlanner.unassigned, ['s04']);
});

test('arrange prompt typography matches student needs input', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*padding: var\(--sp-space-sm\) var\(--sp-space-md\)/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*border-radius: var\(--sp-radius-md\)/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*font-size: 0\.85rem/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*font-family: inherit/s);
  assert.match(styles, /\.sp-arrange-prompt\s*{[^}]*line-height: 1\.6/s);
  assert.match(styles, /\.sp-arrange-prompt::placeholder\s*{[^}]*color: var\(--sp-text-muted\)/s);
  assert.match(styles, /\.sp-arrange-prompt::placeholder\s*{[^}]*opacity: 0\.7/s);
});

test('autocomplete suggestions follow the active light and dark theme', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-autocomplete\s*{[^}]*background: var\(--sp-bg-surface\)/s);
  assert.match(styles, /\.sp-autocomplete\s*{[^}]*border: 1px solid var\(--sp-border\)/s);
  assert.match(styles, /body\.light-mode \.sp-autocomplete\s*{/);
  assert.match(styles, /body\.light-mode \.sp-autocomplete-option\.is-active/);
});

test('blackboard text uses Times New Roman for Latin characters', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.sp-chalk-text\s*{[^}]*font-family: 'Times New Roman'/s);
  assert.match(styles, /\.sp-blackboard-notes\s*{[^}]*font-family: 'Times New Roman'/s);
});

test('chat requests delegate intent classification to the backend', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /\/api\/tools\/seating\/chat/);
  assert.match(source, /const intent = data\.intent/);
  assert.match(source, /intent === 'direct_edit'/);
  assert.match(source, /intent === 'batch_tune'/);
  assert.match(source, /intent === 'regenerate'/);
  assert.doesNotMatch(source, /shouldUseArrangementAssistant/);
  assert.doesNotMatch(source, /detectSeatingMutationIntent/);
});

test('major chat arrangement requests require confirmation before regenerating seats', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /showChatPendingConfirmation\(data\.confirmationText/);
  assert.match(source, /confirmMajorArrangementFromChat/);
  assert.match(source, /这会重新生成座位表并可能大幅改变当前安排，确认继续吗？/);
  assert.match(source, /this\._chatPending\s*=\s*{\s*type: 'arrangement'/s);
  assert.doesNotMatch(source, /showChatArrangementConfirmation/);
});

test('seating planner inserts full row and column aisles from gap handles', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /renderAisleGapHandles/);
  assert.match(source, /localAisles/);
  assert.match(source, /shouldShowRowAisleBoundary/);
  assert.match(source, /shouldShowColumnAisleBoundary/);
  assert.match(source, /this\.insertAisleRowAt\(row\)/);
  assert.match(source, /this\.insertAisleColumnAt\(col\)/);
  assert.doesNotMatch(source, /makeLocalHandle/);
  assert.doesNotMatch(source, /data-local-aisle-orientation/);
  assert.match(styles, /\.sp-aisle-gap/);
});

test('seating planner exports local PNG and styled xlsx', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /ensureHtml2Canvas/);
  assert.match(source, /\/js\/libs\/html2canvas\.min\.js/);
  assert.match(source, /html2canvas-retry/);
  assert.match(source, /typeof window\.html2canvas !== 'function'/);
  assert.match(source, /suppressHtml2CanvasAmdRegistration/);
  assert.match(source, /amdDefine\.amd = undefined/);
  assert.match(source, /amdDefine\.amd = previousAmd/);
  assert.match(source, /sp-export-hide/);
  assert.match(source, /exportXLSX/);
  assert.match(source, /\/api\/tools\/seating\/export-xlsx/);
  assert.match(source, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.doesNotMatch(source, /sp-export-excel'\)\?\.addEventListener\('click', \(\) => this\.exportCSV\(\)\)/);
});

test('seating planner shows score summary and expandable score analysis in the status bar', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /evaluateSeatingQuality/);
  assert.match(source, /sp-toggle-score-analysis/);
  assert.match(source, /renderScoreAnalysisPanel/);
  assert.match(source, /评分 \$\{quality\.percent\} · \$\{quality\.feasible \? '可行' : '需调整'\}/);
  assert.match(source, /highlightScoreIssue/);
  assert.match(source, /highlightSingleMatch/);
  assert.match(source, /formatScoreMatchDetail/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /sp-score-analysis-legend/);
  assert.match(source, /matchButton\.addEventListener\('click', event => \{\s*event\.stopPropagation\(\);\s*this\.highlightSingleMatch\(match\);/s);
  assert.match(source, /sp-score-analysis-match/);
  assert.match(source, /issue\.matches\.forEach/);
  assert.doesNotMatch(source, /shownMatches/);
  assert.doesNotMatch(source, /slice\(0, 4\)/);
  assert.doesNotMatch(source, /还有 \$\{issue\.matches\.length - shownMatches\.length\} 项/);
  assert.match(source, /sp-score-analysis/);
  assert.match(styles, /\.sp-score-analysis/);
  assert.match(styles, /\.sp-score-analysis\s*{[^}]*max-height: min\(36vh, 360px\)/s);
  assert.match(styles, /\.sp-score-analysis\s*{[^}]*overflow-y: auto/s);
  assert.match(styles, /\.sp-score-analysis-detail\s*{[^}]*white-space: normal/s);
  assert.match(styles, /\.sp-score-analysis-match\s*{[^}]*overflow-wrap: anywhere/s);
  assert.match(styles, /\.sp-score-analysis-item/);
  assert.match(styles, /\.sp-score-analysis-item-header/);
  assert.match(styles, /\.sp-score-analysis-legend/);
});

test('seating planner renders a compact horizontal status bar with warning chip', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(source, /sp-status-left/);
  assert.match(source, /sp-status-middle/);
  assert.match(source, /sp-status-right/);
  assert.match(source, /sp-status-warning-chip/);
  assert.match(source, /buildCompactStatusWarning\(unplacedCount\)/);
  assert.match(source, /activateStatusWarningChip\(warning\)/);
  assert.match(source, /statusWarningChip\.addEventListener\('click'/);
  assert.match(source, /this\.showScoreAnalysis = true/);
  assert.match(source, /评分 \$\{quality\.percent\} · \$\{quality\.feasible \? '可行' : '需调整'\}/);
  assert.match(source, /满足 \$\{evaluation\.satisfied\}\/\$\{evaluation\.total\} 需求/);
  assert.match(source, /this\.renderSeatDetailsToggle\(\)/);
  assert.match(source, /querySelector\('#sp-status \.sp-status-right'\)/);
  assert.doesNotMatch(source, /sp-status-primary/);
  assert.doesNotMatch(source, /sp-status-needs-bar/);
  assert.doesNotMatch(source, /sp-status-warnings/);
  assert.doesNotMatch(source, /sp-status-needs-fill/);

  assert.match(styles, /\.sp-status\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.sp-status-left/);
  assert.match(styles, /\.sp-status-middle/);
  assert.match(styles, /\.sp-status-right/);
  assert.match(styles, /\.sp-status-chip/);
  assert.match(styles, /\.sp-status-warning-chip/);
  assert.doesNotMatch(styles, /grid-template-areas:\s*[\s\S]*warnings warnings warnings/);
  assert.doesNotMatch(styles, /\.sp-status-warnings/);
  assert.doesNotMatch(styles, /\.sp-status-needs-bar/);
});

test('seating planner explains parsed physical rows and mixed column layouts', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /layoutFacts\.physicalRows/);
  assert.match(source, /layoutFacts\.columnPattern/);
  assert.match(source, /layoutFacts\.capacityPolicy/);
  assert.match(source, /mixedColumnPattern/);
  assert.match(source, /两边1人组，中间2人组/);
});

test('collapsed AI seating assistant icon can be dragged without opening the panel', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /startChatIconDrag/);
  assert.match(source, /CHAT_DRAG_THRESHOLD/);
  assert.match(source, /suppressChatToggleClick/);
  assert.match(source, /toggle\?\.addEventListener\('pointerdown', e => this\.startChatIconDrag\(e\)\)/);
});

test('arrange prompt completion stays manual without static examples or automatic opening', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /_arrangeSuggestionDismissedText/);
  assert.match(source, /scheduleSuggestionRefresh\(kind, immediate = false, options = \{\}\)/);
  assert.doesNotMatch(source, /sp-arrange-examples/);
  assert.doesNotMatch(source, /applyArrangeExample/);
  assert.doesNotMatch(source, /source: 'input'/);
  assert.doesNotMatch(source, /arrangePrompt\?\.addEventListener\('input'/);
  assert.doesNotMatch(source, /arrangePrompt\?\.addEventListener\('focus', \(\) => this\.scheduleSuggestionRefresh\('arrange', true\)\)/);
  assert.doesNotMatch(source, /scheduleSuggestionRefresh\('arrange', true\)/);
});
