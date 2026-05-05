const DEFAULT_PARSE_MAX_TOKENS = 4096;

const DIRECT_TYPES = new Set([
    'front_row',
    'back_row',
    'avoid',
    'not_adjacent',
    'prefer',
    'prefer_near',
    'pair',
    'must_adjacent',
    'avoid_first_row',
    'avoid_last_row',
    'avoid_front_row',
    'avoid_back_row',
    'avoid_behind',
    'avoid_near',
    'prefer_front_middle',
    'prefer_front_mid_rows',
    'prefer_aisle',
    'prefer_edge',
    'prefer_high_grade_neighbor',
    'avoid_low_grade_deskmate',
]);

const ROW_AVOID_TYPES = new Set([
    'avoid_first_row',
    'avoid_last_row',
    'avoid_front_row',
    'avoid_back_row',
]);

function asText(value) {
    return String(value ?? '').trim();
}

function normalizePriority(value, fallback = 'hard') {
    const text = asText(value).toLowerCase();
    return text === 'soft' ? 'soft' : text === 'hard' ? 'hard' : fallback;
}

function hasSoftPriorityCue(value) {
    return /(最好.*不要|尽量.*不要|可以的话|不太想|希望不要|不希望|不想|希望|想|最好|尽量|优先|尽可能|方便)/.test(asText(value));
}

function hasHardPriorityCue(value) {
    const text = asText(value);
    if (/(视力不好|近视严重|严重近视|看不清|看不见|看不到|被挡|挡住|遮挡)/.test(text)) return true;
    if (/(最好.*不要|尽量.*不要|可以的话.*不要|不太想|希望不要)/.test(text)) return false;
    return /(必须|需要|一定|务必|不能|不可|不可以|不准|禁止|绝对|千万)/.test(text);
}

function defaultPriorityForType(type, fallback = 'hard') {
    const normalizedType = asText(type);
    if (normalizedType.startsWith('prefer')) return 'soft';
    if (normalizedType === 'front_row' || normalizedType === 'back_row') return 'soft';
    if (normalizedType === 'avoid_behind') return 'soft';
    return fallback;
}

function priorityForNeed({ type, text, suggestedPriority, fallback } = {}) {
    const combined = asText(text);
    if (hasHardPriorityCue(combined)) return 'hard';
    if (hasSoftPriorityCue(combined)) return 'soft';
    return normalizePriority(suggestedPriority, defaultPriorityForType(type, fallback));
}

function studentNames(students = []) {
    return [...new Set((students || [])
        .map(student => asText(student?.name || student?.id))
        .filter(Boolean))]
        .sort((a, b) => b.length - a.length);
}

function findRosterNames(value, names = []) {
    const text = asText(value);
    if (!text) return [];
    return names
        .filter(name => text.includes(name))
        .sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

function looksLikeRowOrPlaceholder(value) {
    return /(前排|后排|第一排|最后一排|中排|过道|位置|成绩|同学|学生|较好|偏低|较高|中间|靠边|边上|外侧)/.test(asText(value));
}

function looksLikeDescriptorNotName(value) {
    return /^(高个子|矮个子|胖子|瘦子|近视|近视的|戴眼镜|戴眼镜的|视力不好|个子高|个子高的|个子矮|个子矮的|个头高|个头高的|个头矮|个头矮的|身高高|身高高的|身高较高|身高矮|身高矮的|身高较矮|大个子|小个子|高的|矮的|胖的|瘦的|高的同学|矮的同学|胖的同学|瘦的同学)$/.test(asText(value));
}

function shouldPreferFrontRowForView(value) {
    const text = asText(value);
    if (!text) return false;
    return /(看不清|看不见|看不到).*(黑板|屏幕|投影|老师|前面)?/.test(text)
        || /(近视|戴眼镜|视力不好)/.test(text)
        || /(高个子|个子高|个头高|身高高|身高较高|大个子).*(后面|后方|身后|挡|遮挡|挡住)/.test(text)
        || /(后面|后方|身后).*(高个子|个子高|个头高|身高高|身高较高|大个子)/.test(text)
        || /被.*(挡|遮挡|挡住)/.test(text)
        || /(矮个子|个子矮|个头矮|身高矮|身高较矮|小个子).*(后面|后排|看不清|看不见|看不到)/.test(text);
}

function frontRowPriorityForView(value) {
    return /(必须|需要|看不清|看不见|看不到|视力不好|近视严重)/.test(asText(value)) ? 'hard' : 'soft';
}

function shouldAvoidFrontRowForTallStudent(value) {
    const text = asText(value);
    if (!text) return false;
    return /(自己|本人|我|身高较高|身高高|个子高|个头高|高个子|大个子)/.test(text)
        && /(挡住|遮挡|影响).*(别人|同学|后排)|怕.*(挡住|遮挡).*(别人|同学|后排)/.test(text);
}

function splitNameList(value, context = {}) {
    const raw = asText(value)
        .replace(/[()（）]/g, '')
        .replace(/^(和|跟|与|同)\s*/, '')
        .replace(/\s*(一起|坐得近一些|坐得近|相邻|同桌).*$/, '')
        .trim();
    if (!raw || looksLikeRowOrPlaceholder(raw)) return [];

    const names = studentNames(context.students);
    const rosterMatches = findRosterNames(raw, names);
    if (rosterMatches.length) return rosterMatches;

    return raw
        .split(/[、,，;；/和或与及\s]+/)
        .map(item => item.trim())
        .filter(item => item && !looksLikeRowOrPlaceholder(item) && !looksLikeDescriptorNotName(item));
}

function splitTargets(value, context = {}) {
    const names = splitNameList(value, context);
    const raw = asText(value);
    if (names.length) return names;
    return raw && !looksLikeRowOrPlaceholder(raw) ? [raw] : [];
}

function firstMarkerIndex(sentence) {
    const markers = ['不希望', '不想', '不能', '不要', '不可以', '最好', '希望', '想', '需要', '必须', '因为', '成绩', '身高', '可以'];
    return markers
        .map(marker => sentence.indexOf(marker))
        .filter(index => index >= 0)
        .sort((a, b) => a - b)[0] ?? -1;
}

function extractTargets(sentence, context = {}) {
    const marker = firstMarkerIndex(sentence);
    const prefix = marker >= 0 ? sentence.slice(0, marker) : sentence;
    const fromPrefix = splitTargets(prefix, context);
    if (fromPrefix.length) return fromPrefix;
    const names = findRosterNames(sentence, studentNames(context.students));
    return names.length ? [names[0]] : [];
}

function relatedValues(value, context = {}) {
    const raw = asText(value);
    if (!raw) return [''];
    const names = splitNameList(raw, context);
    return names.length ? names : [raw];
}

function addConstraint(list, constraint) {
    const type = asText(constraint.type);
    const target = asText(constraint.target);
    if (!type || !target) return;
    list.push({
        type,
        target,
        ...(constraint.related ? { related: asText(constraint.related) } : {}),
        reason: asText(constraint.reason) || '学生需求',
        priority: normalizePriority(constraint.priority, constraint.type?.startsWith('prefer') ? 'soft' : 'hard'),
    });
}

function pairwise(names = []) {
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            pairs.push([names[i], names[j]]);
        }
    }
    return pairs;
}

function isFirstRowText(value) {
    return /第一排|第1排|首排/.test(asText(value));
}

function isLastRowText(value) {
    return /最后一排|末排|最后排|倒数第一排/.test(asText(value));
}

function isFrontRowText(value) {
    return /前排|前面|前方/.test(asText(value));
}

function isBackRowText(value) {
    return /后排|后面|后方/.test(asText(value));
}

function isAisleText(value) {
    return /过道|走道/.test(asText(value));
}

function isEdgeText(value) {
    return /靠边|边上|外侧|边列|靠窗|靠墙/.test(asText(value));
}

function isHighGradeText(value) {
    return /成绩较好|成绩好|成绩高|优秀|高分|较好的同学|较好的学生/.test(asText(value));
}

function isLowGradeText(value) {
    return /成绩同样偏低|成绩偏低|低分|较低/.test(asText(value));
}

function isNotAdjacentText(value) {
    return /(同桌|坐一起|相邻)/.test(asText(value));
}

function mapAiConstraint({ type, target, related, reason, priority }, context) {
    const combined = `${reason} ${related}`.trim();
    const soft = priorityForNeed({ type, text: combined, suggestedPriority: priority, fallback: 'soft' });
    const hard = priorityForNeed({ type, text: combined, suggestedPriority: priority, fallback: 'hard' });
    const rowHard = normalizePriority(priority, 'hard');

    if ((type === 'avoid' || type === 'not_adjacent') && isFirstRowText(combined)) {
        return [{ type: 'avoid_first_row', target, reason, priority: rowHard }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && isLastRowText(combined)) {
        return [{ type: 'avoid_last_row', target, reason, priority: rowHard }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && isFrontRowText(combined) && !isBackRowText(combined)) {
        return [{ type: 'avoid_front_row', target, reason, priority: rowHard }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && isBackRowText(combined) && !/坐在.*后面|其后面|后面/.test(combined)) {
        return [{ type: 'avoid_back_row', target, reason, priority: rowHard }];
    }
    if ((type === 'prefer' || type === 'front_row') && /前排.*中间|前排中间|正中间/.test(combined) && !/不一定/.test(combined)) {
        return [{ type: 'prefer_front_middle', target, reason, priority: soft }];
    }
    if ((type === 'prefer' || type === 'front_row') && /前中排|前中/.test(combined)) {
        return [{ type: 'prefer_front_mid_rows', target, reason, priority: soft }];
    }
    if (type === 'prefer' && isBackRowText(combined)) {
        const mapped = [{ type: 'back_row', target, reason, priority: soft }];
        if (isEdgeText(combined)) mapped.push({ type: 'prefer_edge', target, reason, priority: soft });
        if (isAisleText(combined)) mapped.push({ type: 'prefer_aisle', target, reason, priority: soft });
        return mapped;
    }
    if ((type === 'prefer' || type === 'front_row') && isAisleText(combined)) {
        return [{ type: 'prefer_aisle', target, reason, priority: soft }];
    }
    if ((type === 'prefer' || type === 'front_row' || type === 'back_row')
        && isEdgeText(combined)
        && !/(不希望|不想|不要).*?(靠边|边上|外侧|边列|靠窗|靠墙)/.test(combined)) {
        const mapped = [];
        if (type === 'front_row' || type === 'back_row') mapped.push({ type, target, reason, priority: soft });
        mapped.push({ type: 'prefer_edge', target, reason, priority: soft });
        return mapped;
    }
    if (type === 'prefer' && isHighGradeText(combined)) {
        return [{ type: 'prefer_high_grade_neighbor', target, reason, priority: soft }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && isLowGradeText(combined)) {
        return [{ type: 'avoid_low_grade_deskmate', target, reason, priority: hard }];
    }
    const relatedName = splitNameList(related, context)[0];
    const relatedText = asText(related);
    const relatedIsDescriptor = relatedText && looksLikeDescriptorNotName(relatedText);
    if ((!relatedName || relatedIsDescriptor) && shouldPreferFrontRowForView(combined)) {
        return [{ type: 'front_row', target, reason, priority: frontRowPriorityForView(combined) }];
    }
    if (shouldAvoidFrontRowForTallStudent(combined)) {
        return [{ type: 'avoid_front_row', target, reason, priority: rowHard }];
    }

    if (relatedIsDescriptor && ['avoid', 'not_adjacent', 'avoid_behind', 'avoid_near', 'prefer', 'prefer_near', 'pair', 'must_adjacent'].includes(type)) {
        return [];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && relatedName && isNotAdjacentText(combined)) {
        return [{
            type: 'not_adjacent',
            target,
            related: relatedName,
            reason,
            priority: priorityForNeed({ type: 'not_adjacent', text: combined, suggestedPriority: priority, fallback: 'hard' }),
        }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && relatedName && /(后面|后方|身后|其后面)/.test(combined)) {
        return [{
            type: 'avoid_behind',
            target,
            related: relatedName,
            reason,
            priority: priorityForNeed({ type: 'avoid_behind', text: combined, suggestedPriority: priority, fallback: 'soft' }),
        }];
    }
    if ((type === 'avoid' || type === 'not_adjacent') && relatedName && /(过近|太近|靠太近|坐得近)/.test(combined)) {
        return [{
            type: 'avoid_near',
            target,
            related: relatedName,
            reason,
            priority: priorityForNeed({ type: 'avoid_near', text: combined, suggestedPriority: priority, fallback: 'hard' }),
        }];
    }
    if (type === 'prefer' && relatedName && /(近一些|坐得近|交流|相邻|同桌)/.test(combined)) {
        return [{ type: 'prefer_near', target, related: relatedName, reason, priority: soft }];
    }

    if (DIRECT_TYPES.has(type)) {
        return [{
            type,
            target,
            ...(relatedName || asText(related) ? { related: relatedName || asText(related) } : {}),
            reason,
            priority: ROW_AVOID_TYPES.has(type)
                ? normalizePriority(priority, 'hard')
                : priorityForNeed({ type, text: combined, suggestedPriority: priority, fallback: defaultPriorityForType(type) }),
        }];
    }
    return [];
}

export function dedupeConstraints(constraints = []) {
    const seen = new Set();
    const result = [];
    for (const constraint of constraints) {
        const type = asText(constraint.type);
        const target = asText(constraint.target);
        if (!type || !target) continue;
        const normalized = {
            type,
            target,
            ...(constraint.related ? { related: asText(constraint.related) } : {}),
            reason: asText(constraint.reason) || '学生需求',
            priority: normalizePriority(constraint.priority, type.startsWith('prefer') ? 'soft' : 'hard'),
        };
        const key = `${normalized.type}|${normalized.target}|${normalized.related || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
    }
    return result;
}

export function normalizeConstraintItems(items = [], context = {}) {
    const normalized = [];
    for (const item of Array.isArray(items) ? items : []) {
        const type = asText(item?.type);
        const targets = splitTargets(item?.target, context);
        if (!type || !targets.length) continue;
        for (const target of targets) {
            for (const related of relatedValues(item?.related, context)) {
                normalized.push(...mapAiConstraint({
                    type,
                    target,
                    related,
                    reason: asText(item?.reason) || '学生需求',
                    priority: item?.priority,
                }, context));
            }
        }
    }
    return dedupeConstraints(normalized);
}

function addForTargets(list, targets, constraint) {
    for (const target of targets) addConstraint(list, { ...constraint, target });
}

function extractRelatedAfter(sentence, regex, context) {
    const match = sentence.match(regex);
    if (!match) return [];
    const captured = match.slice(1).find(Boolean);
    return splitNameList(captured, context);
}

function sentenceClauses(sentence) {
    return asText(sentence)
        .split(/[，,；;]+/)
        .map(clause => clause.trim())
        .filter(Boolean);
}

function hasClauseMatching(sentence, regex) {
    return sentenceClauses(sentence).some(clause => regex.test(clause));
}

export function parseSeatingConstraintsLocally({ text, students = [] } = {}) {
    const context = { students };
    const constraints = [];
    const sentences = asText(text)
        .split(/[。！？!?\n]+/)
        .map(sentence => sentence.trim())
        .filter(Boolean);

    for (const sentence of sentences) {
        const targets = extractTargets(sentence, context);
        if (!targets.length) continue;

        if (/前排中间/.test(sentence) && !/不一定要?正?中间/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'prefer_front_middle', reason: '希望坐在前排中间', priority: 'soft' });
        } else if (/前中排|前中/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'prefer_front_mid_rows', reason: '希望坐在前中排', priority: 'soft' });
        } else if (/(希望|想|需要|必须).*?(前排|靠前)|坐得靠前/.test(sentence)
            && !/(不希望|不想|不要).*?前排/.test(sentence)) {
            addForTargets(constraints, targets, {
                type: 'front_row',
                reason: /靠前/.test(sentence) ? '希望坐得靠前一些' : '希望坐在前排',
                priority: /(必须|需要|视力不好|看不清)/.test(sentence) ? 'hard' : 'soft',
            });
        }
        if (shouldPreferFrontRowForView(sentence) && !/(不希望|不想|不要).*?前排/.test(sentence)) {
            addForTargets(constraints, targets, {
                type: 'front_row',
                reason: '希望坐在前排以看清黑板',
                priority: frontRowPriorityForView(sentence),
            });
        }

        if (/(不希望|不想|不要).*?第一排/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'avoid_first_row', reason: '不希望坐在第一排', priority: 'hard' });
        }
        if (/(不希望|不想|不要|希望不要).*?(最后一排|末排|最后排)/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'avoid_last_row', reason: '不希望坐在最后一排', priority: 'hard' });
        }
        if (/(不希望|不想|不要).*?前排/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'avoid_front_row', reason: '不希望坐前排', priority: 'hard' });
        }
        if (shouldAvoidFrontRowForTallStudent(sentence)) {
            addForTargets(constraints, targets, { type: 'avoid_front_row', reason: '身高较高，避免遮挡后排同学', priority: 'hard' });
        }
        if (hasClauseMatching(sentence, /(不希望|不想|不要).*?坐(?:在)?后排/)) {
            addForTargets(constraints, targets, { type: 'avoid_back_row', reason: '不希望坐后排', priority: 'hard' });
        }
        if (hasClauseMatching(sentence, /(希望|想|最好|尽量|可以的话|优先|倾向).*?(中后排|后排|靠后)/)) {
            addForTargets(constraints, targets, { type: 'back_row', reason: '希望坐在后排区域', priority: 'soft' });
        }

        const behind = extractRelatedAfter(sentence, /(?:不想|不希望|不要|不能|不可以)坐在(.+?)后面|(?:不想|不希望|不要|不能|不可以)坐.*?在(.+?)后面/, context);
        for (const target of targets) {
            for (const related of behind.filter(name => name !== target && !looksLikeDescriptorNotName(name))) {
                addConstraint(constraints, {
                    type: 'avoid_behind',
                    target,
                    related,
                    reason: '不想坐在其后面',
                    priority: priorityForNeed({ type: 'avoid_behind', text: sentence, fallback: 'soft' }),
                });
            }
        }

        if (isNotAdjacentText(sentence) && /(不想|不希望|不要|不能|不可以|最好)/.test(sentence)) {
            const priority = priorityForNeed({ type: 'not_adjacent', text: sentence, fallback: 'hard' });
            if (targets.length > 1) {
                for (const [target, related] of pairwise(targets)) {
                    addConstraint(constraints, { type: 'not_adjacent', target, related, reason: '不希望坐一起或同桌', priority });
                }
            }
            const notAdjacentRelated = [
                ...extractRelatedAfter(sentence, /(?:不想|不希望|不要|不能|不可以)(?:和|跟|与)(.+?)(?:同桌|坐一起|相邻)/, context),
                ...extractRelatedAfter(sentence, /最好(?:和|跟|与)(.+?)(?:不要|别)(?:同桌|坐一起|相邻)/, context),
                ...extractRelatedAfter(sentence, /最好(?:不要|别)(?:和|跟|与)(.+?)(?:同桌|坐一起|相邻)/, context),
            ];
            for (const target of targets) {
                for (const related of notAdjacentRelated.filter(name => name !== target && !looksLikeDescriptorNotName(name))) {
                    addConstraint(constraints, { type: 'not_adjacent', target, related, reason: '不希望坐一起或同桌', priority });
                }
            }
        }

        const near = extractRelatedAfter(sentence, /希望(?:和|跟|与)(.+?)(?:坐得近|坐近|相邻|同桌)/, context);
        for (const target of targets) {
            for (const related of near.filter(name => name !== target)) {
                addConstraint(constraints, { type: 'prefer_near', target, related, reason: '希望坐得近一些', priority: 'soft' });
            }
        }

        if (/旁边.*?(成绩较好|成绩好|成绩高|优秀|高分)|成绩较好.*?旁边/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'prefer_high_grade_neighbor', reason: '希望旁边有成绩较好的同学', priority: 'soft' });
        }
        if (/(不希望|不想|不要).*?成绩.*?(偏低|较低|低分).*?(同桌|相邻|旁边)/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'avoid_low_grade_deskmate', reason: '不希望和成绩同样偏低的同学同桌', priority: 'hard' });
        }
        if (/靠过道|过道位置|走道/.test(sentence)) {
            addForTargets(constraints, targets, { type: 'prefer_aisle', reason: '希望坐在靠过道位置', priority: 'soft' });
        }
        if (hasClauseMatching(sentence, /(希望|想|最好|尽量|可以的话|优先|倾向).*?(靠边|边上|外侧|边列|靠窗|靠墙)/)) {
            addForTargets(constraints, targets, { type: 'prefer_edge', reason: '希望坐在靠边位置', priority: 'soft' });
        }
        if (/(分散|不希望.*?(过近|太近)|不想.*?(过近|太近))/.test(sentence) && targets.length > 1) {
            for (const [target, related] of pairwise(targets)) {
                addConstraint(constraints, { type: 'avoid_near', target, related, reason: '不希望坐得过近', priority: 'hard' });
            }
        }
    }

    return dedupeConstraints(constraints);
}

function parseMaxTokens(env = {}) {
    const parsed = Number.parseInt(env.SEATING_CONSTRAINT_PARSE_MAX_TOKENS, 10);
    if (Number.isInteger(parsed) && parsed >= 1024) return parsed;
    return DEFAULT_PARSE_MAX_TOKENS;
}

function buildConstraintParseMessages({ text, students = [] }) {
    const systemPrompt = `你是座位安排学生需求解析器。从老师的话中提取所有学生约束。
只输出紧凑 JSON，不要 markdown。输出结构：{"constraints":[{"type":"front_row","target":"张三","related":"李四","reason":"简短原因","priority":"hard"}]}
priority 必须输出 "hard" 或 "soft"：hard=必须满足，未满足会导致需调整；soft=尽量满足，只影响评分。包含“必须、需要、一定、不能、不可以、视力不好、近视严重、看不清、看不见、被挡住”等强制或健康/视力原因时输出 hard；普通“想、希望、最好、尽量、可以的话、不想”等偏好通常输出 soft。avoid_behind 不要按类型一律 hard，必须根据语义判断：普通“不想坐在 X 后面”为 soft，视力原因或“必须不能/不能”才 hard。
可用 type:
- front_row/back_row: 希望或必须在前排/后排区域
- avoid_first_row/avoid_last_row/avoid_front_row/avoid_back_row: 不想坐第一排/最后一排/前排/后排
- avoid_behind: target 不想坐在 related 后面
- avoid/not_adjacent/avoid_near: 不相邻/不要太近
- prefer/prefer_near/pair/must_adjacent: 希望近、必须相邻
- prefer_front_middle/prefer_front_mid_rows/prefer_aisle/prefer_edge: 前排中间、前中排、靠过道、靠边/边上/外侧
- prefer_high_grade_neighbor/avoid_low_grade_deskmate: 希望成绩好邻座、避免低分同桌
多人列表必须拆成多条约束；如果是“甲、乙、丙不希望坐第一排”，三人各一条。
关键判别：
- “不想坐第一排，希望坐后排靠边”必须输出 avoid_first_row + back_row + prefer_edge，不能输出 avoid_back_row。
- “靠边、边上、外侧、边列、靠窗、靠墙”输出 prefer_edge；“靠过道、走道”输出 prefer_aisle。
描述词规则：
- “高个子、矮个子、胖子、瘦子、近视、戴眼镜、看不清、看不见、被挡住、遮挡”通常不是学生姓名，不要放入 related。
- “不想坐在高个子后面、怕被挡住、看不清黑板、近视、矮个子坐后面看不见”输出 front_row。
- “自己个子高、身高较高、怕挡住别人、不想坐前排”输出 avoid_front_row。
- 没有明确可执行座位含义的身体描述词不要生成具体同学关系约束。`;

    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: JSON.stringify({
                teacherText: text,
                students: (students || []).map(student => student?.name || student?.id).filter(Boolean),
            }),
        },
    ];
}

export async function parseSeatingConstraints({
    text,
    students = [],
    fetchImpl = globalThis.fetch,
    env = process.env,
} = {}) {
    const warnings = [];
    let raw = '';
    let aiConstraints = [];
    let constraints = [];
    let source = 'local_rules_fallback';
    let usedAi = false;

    if (typeof fetchImpl === 'function' && env?.DEEPSEEK_API_BASE && env?.DEEPSEEK_API_KEY) {
        try {
            const response = await fetchImpl(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
                },
                body: JSON.stringify({
                    model: env.DEEPSEEK_MODEL || env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
                    messages: buildConstraintParseMessages({ text, students }),
                    temperature: 0.1,
                    max_tokens: parseMaxTokens(env),
                    response_format: { type: 'json_object' },
                }),
                signal: AbortSignal.timeout(60000),
            });

            const payload = await response.json();
            if (!response.ok) {
                warnings.push(payload?.error?.message || `AI 学生需求解析失败: ${response.status}`);
            } else {
                raw = payload.choices?.[0]?.message?.content || '{}';
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed?.constraints)) {
                        aiConstraints = normalizeConstraintItems(parsed.constraints, { students });
                        constraints = aiConstraints;
                        source = 'ai_constraints';
                        usedAi = true;
                    } else {
                        warnings.push('AI 返回的学生需求 JSON 缺少 constraints 数组，已使用本地备用规则。');
                    }
                } catch (error) {
                    warnings.push(`AI 返回的学生需求 JSON 无效，已使用本地备用规则：${error.message}`);
                }
            }
        } catch (error) {
            warnings.push(`AI 学生需求解析不可用，已使用本地备用规则：${error.message}`);
        }
    }

    if (!usedAi) {
        constraints = parseSeatingConstraintsLocally({ text, students });
    }

    // Cap constraint count to prevent score collapse from inflation
    const MAX_CONSTRAINTS = 100;
    if (constraints.length > MAX_CONSTRAINTS) {
        const isSoft = c => c?.priority === 'soft';
        const hard = constraints.filter(c => !isSoft(c));
        const soft = constraints.filter(c => isSoft(c));
        const hardKeep = hard.slice(0, MAX_CONSTRAINTS);
        const softKeep = soft.slice(0, Math.max(0, MAX_CONSTRAINTS - hardKeep.length));
        const totalBefore = constraints.length;
        constraints = [...hardKeep, ...softKeep];
        warnings.push(`学生需求过多（${totalBefore}条），已保留最重要的 ${constraints.length} 条`);
    }

    return {
        constraints,
        raw,
        warnings,
        source,
    };
}
