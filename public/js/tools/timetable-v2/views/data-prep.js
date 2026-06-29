/**
 * timetable-v2 / views / data-prep.js
 *
 * 数据准备：调用 /import 生成预览，再由用户确认后调用 /project 保存。
 * 前端只采集来源文本 / JSON，不构造业务对象，不做可行性判断。
 */

const STYLE_ID = 'ttv2-view-data-prep-style';
let fieldIdSeq = 0;
const STYLE_TEXT = '';

function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
}

function bindLabel(label, control, prefix = 'ttv2-data-prep-field') {
    if (!control.id) {
        fieldIdSeq += 1;
        control.id = `${prefix}-${fieldIdSeq}`;
    }
    label.htmlFor = control.id;
}

function field(labelText, control) {
    const wrap = document.createElement('div');
    wrap.className = 'ttv2-view__field';
    const label = document.createElement('label');
    label.textContent = labelText;
    bindLabel(label, control);
    wrap.append(label, control);
    return wrap;
}

function stat(num, label) {
    const box = document.createElement('div');
    box.className = 'ttv2-view__stat';
    const n = document.createElement('span');
    n.className = 'ttv2-view__stat-num';
    n.textContent = String(num ?? 0);
    const l = document.createElement('span');
    l.className = 'ttv2-view__stat-label';
    l.textContent = label;
    box.append(n, l);
    return box;
}

function reportEntries(report) {
    if (!report) return [];
    if (Array.isArray(report.entries)) return report.entries;
    if (Array.isArray(report.items)) return report.items;
    const buckets = ['kept', 'degraded', 'dropped', 'review'];
    return buckets.flatMap((key) => Array.isArray(report[key]) ? report[key].map((item) => ({ ...item, category: key })) : []);
}

function parseImportText(source, text) {
    const trimmed = text.trim();
    if (!trimmed) return '';
    if (source === 'excel') return trimmed;
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsText(file, 'utf-8');
    });
}

const SOURCE_OPTIONS = [
    ['xlsx', 'Excel 工作簿（.xlsx）'],
    ['excel', 'CSV / TSV 任课表'],
    ['legacy', '旧 ICeCream JSON'],
    ['crystal', '水晶 cloneSeed JSON'],
    ['yqd', 'YQD 业务表 JSON'],
];

const SOURCE_ACCEPT = {
    xlsx: '.xlsx,.xls',
    excel: '.csv,.tsv,.txt',
    legacy: '.json,.txt',
    crystal: '.json,.txt',
    yqd: '.json,.txt',
};

const SOURCE_PLACEHOLDER = {
    xlsx: '请选择 .xlsx 文件，系统会读取第一个工作表。',
    excel: 'CSV/TSV 示例：年级,班级,课程,教师,周课时,连堂,教室\n七年级,一班,语文,张老师,5,single,',
    legacy: '粘贴旧 ICeCream JSON 项目数据。',
    crystal: '粘贴水晶排课 cloneSeed JSON。',
    yqd: '粘贴 YQD 业务表 JSON。',
};

function projectNameFromFile(file) {
    const name = String(file?.name || '').replace(/\.[^.]+$/, '').trim();
    return name || '智能排课导入项目';
}

export function createDataPrepView({ store, api }) {
    ensureStyle();

    const el = document.createElement('section');
    el.className = 'ttv2-view ttv2-view--data-prep';

    const hero = document.createElement('div');
    hero.className = 'ttv2-view__hero';
    const copy = document.createElement('div');
    const title = document.createElement('h1');
    title.className = 'ttv2-view__title';
    title.textContent = '数据准备';
    const hint = document.createElement('p');
    hint.className = 'ttv2-view__hint';
    hint.textContent = '先导入任课数据预览，确认迁移报告无明显问题后保存为 V2 项目。';
    copy.append(title, hint);
    hero.append(copy);

    const grid = document.createElement('div');
    grid.className = 'ttv2-view__grid';

    const importCard = document.createElement('div');
    importCard.className = 'ttv2-view__card';
    const importTitle = document.createElement('h2');
    importTitle.className = 'ttv2-view__card-title';
    importTitle.textContent = '导入来源';

    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'ttv2-select';
    for (const [value, label] of SOURCE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sourceSelect.append(opt);
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.className = 'ttv2-input';
    fileInput.accept = SOURCE_ACCEPT[sourceSelect.value] || '';

    const textarea = document.createElement('textarea');
    textarea.className = 'ttv2-textarea';
    textarea.placeholder = SOURCE_PLACEHOLDER[sourceSelect.value] || '';

    const actionRow = document.createElement('div');
    actionRow.className = 'ttv2-action-row';
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'ttv2-btn';
    previewBtn.textContent = '生成导入预览';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ttv2-btn ttv2-btn--ghost';
    saveBtn.textContent = '保存为项目';
    actionRow.append(previewBtn, saveBtn);

    const msg = document.createElement('div');
    msg.className = 'ttv2-message';

    importCard.append(
        importTitle,
        field('来源类型', sourceSelect),
        field('上传文件', fileInput),
        field('或粘贴原始内容', textarea),
        actionRow,
        msg,
    );

    const summaryCard = document.createElement('div');
    summaryCard.className = 'ttv2-view__card';
    const summaryTitle = document.createElement('h2');
    summaryTitle.className = 'ttv2-view__card-title';
    summaryTitle.textContent = '项目摘要';
    const summaryName = document.createElement('p');
    summaryName.className = 'ttv2-view__hint';
    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'ttv2-view__summary';
    summaryCard.append(summaryTitle, summaryName, summaryGrid);

    const reportCard = document.createElement('div');
    reportCard.className = 'ttv2-view__card ttv2-view__card--wide';
    const reportTitle = document.createElement('h2');
    reportTitle.className = 'ttv2-view__card-title';
    reportTitle.textContent = '导入报告';
    const reportList = document.createElement('ul');
    reportList.className = 'ttv2-list';
    reportCard.append(reportTitle, reportList);

    grid.append(importCard, summaryCard, reportCard);
    el.append(hero, grid);

    function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.classList.toggle('ttv2-message--ok', kind === 'ok');
        msg.classList.toggle('ttv2-message--err', kind === 'err');
    }

    function currentProject() {
        return store.getState().importPreview?.project || store.getState().project;
    }

    function updateSourceControls() {
        const source = sourceSelect.value;
        fileInput.accept = SOURCE_ACCEPT[source] || '';
        textarea.placeholder = SOURCE_PLACEHOLDER[source] || '';
        textarea.disabled = source === 'xlsx';
        textarea.setAttribute('aria-disabled', source === 'xlsx' ? 'true' : 'false');
        if (source === 'xlsx') textarea.value = '';
        fileInput.value = '';
        setMsg('', null);
    }

    function renderSummary() {
        const project = currentProject();
        const preview = store.getState().importPreview;
        summaryGrid.replaceChildren();
        if (!project) {
            summaryName.textContent = '暂无项目。请导入数据生成预览。';
            return;
        }
        summaryName.textContent = `${preview ? '预览：' : '当前：'}${project.name || '未命名项目'}`;
        summaryGrid.append(
            stat(project.classes?.length, '班级'),
            stat(project.teachers?.length, '教师'),
            stat(project.subjects?.length, '课程'),
            stat(project.rooms?.length, '教室'),
            stat(project.activityPlans?.length, '任课计划'),
            stat(project.constraints?.length, '规则'),
        );
    }

    function renderReport() {
        const report = store.getState().migrationReport;
        const entries = reportEntries(report).slice(0, 10);
        reportList.replaceChildren();
        if (!report) {
            const empty = document.createElement('li');
            empty.className = 'ttv2-empty';
            empty.textContent = '导入后会在这里显示保留、降级、丢弃和待审字段。';
            reportList.append(empty);
            return;
        }
        const summary = report.summary || {};
        const head = document.createElement('li');
        head.className = 'ttv2-report-item';
        head.textContent = `汇总：保留 ${summary.kept || 0}，降级 ${summary.degraded || 0}，丢弃 ${summary.dropped || 0}，待审 ${summary.review || 0}`;
        reportList.append(head);

        if (!entries.length) return;
        for (const entry of entries) {
            const li = document.createElement('li');
            li.className = 'ttv2-report-item';
            li.textContent = `${entry.category || entry.kind || 'report'} · ${entry.field || ''} · ${entry.reason || entry.message || ''}`;
            reportList.append(li);
        }
    }

    async function importPreview() {
        previewBtn.disabled = true;
        saveBtn.disabled = true;
        setMsg('正在导入并生成预览...', null);
        try {
            const file = fileInput.files && fileInput.files[0];
            const source = sourceSelect.value;
            const options = { name: projectNameFromFile(file) };
            if (source === 'xlsx') {
                if (!file) {
                    setMsg('请选择要导入的 Excel 工作簿。', 'err');
                    return;
                }
                const result = await api.importProject({ source, file, options });
                store.dispatch('setImportPreview', result);
                setMsg('Excel 导入预览已生成，请检查摘要和报告后保存。', 'ok');
                return;
            }

            const text = file ? await readFileAsText(file) : textarea.value;
            const data = parseImportText(source, text);
            if (!data) {
                setMsg('请先上传文件或粘贴内容。', 'err');
                return;
            }
            const result = await api.importProject({ source, data, options });
            store.dispatch('setImportPreview', result);
            setMsg('导入预览已生成，请检查摘要和报告后保存。', 'ok');
        } catch (error) {
            setMsg(error.message || '导入失败', 'err');
        } finally {
            previewBtn.disabled = false;
            saveBtn.disabled = !store.getState().importPreview?.project;
        }
    }

    async function savePreview() {
        const preview = store.getState().importPreview;
        if (!preview?.project) {
            setMsg('请先生成导入预览。', 'err');
            return;
        }
        saveBtn.disabled = true;
        setMsg('正在保存项目...', null);
        try {
            const project = await api.saveProject(preview.project, {
                expectedRevision: store.getState().project?.revision ?? preview.project?.revision,
            });
            store.dispatch('setProject', project);
            store.dispatch('clearImportPreview');
            setMsg('项目已保存，可以进入规则输入。', 'ok');
        } catch (error) {
            setMsg(error.message || '保存失败', 'err');
        } finally {
            saveBtn.disabled = false;
        }
    }

    previewBtn.addEventListener('click', importPreview);
    saveBtn.addEventListener('click', savePreview);
    sourceSelect.addEventListener('change', updateSourceControls);

    let unsub = null;

    return {
        el,
        mount() {
            unsub = store.subscribe(() => {
                renderSummary();
                renderReport();
                saveBtn.disabled = !store.getState().importPreview?.project;
            });
            renderSummary();
            renderReport();
            updateSourceControls();
            saveBtn.disabled = !store.getState().importPreview?.project;
        },
        update() {
            renderSummary();
            renderReport();
        },
        destroy() {
            if (unsub) { unsub(); unsub = null; }
            sourceSelect.removeEventListener('change', updateSourceControls);
            el.remove();
        },
    };
}
