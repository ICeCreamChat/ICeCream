const NUMBER_PATTERN = '[-+]?\\d+(?:\\.\\d+)?';

function formatNumber(value) {
    const rounded = Math.round(Number(value) * 1000000) / 1000000;
    if (Object.is(rounded, -0)) return '0';
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatSquaredTerm(variable, centerValue) {
    const center = Number(centerValue);
    if (Math.abs(center) < 1e-9) return `${variable}^2`;
    if (center > 0) return `(${variable} - ${formatNumber(center)})^2`;
    return `(${variable} + ${formatNumber(Math.abs(center))})^2`;
}

function formatRadical(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return `√${formatNumber(value)}`;
    if (Math.abs(number) < 1e-9) return '0';
    const roundedInteger = Math.round(number);
    if (Math.abs(number - roundedInteger) > 1e-9) return `√${formatNumber(number)}`;

    let coefficient = 1;
    let remainder = roundedInteger;
    for (let factor = 2; factor * factor <= remainder; factor += 1) {
        while (remainder % (factor * factor) === 0) {
            coefficient *= factor;
            remainder /= factor * factor;
        }
    }
    if (remainder === 1) return formatNumber(coefficient);
    return coefficient === 1 ? `√${remainder}` : `${coefficient}√${remainder}`;
}

export function normalizeGeoGebraProblemText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
        .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
        .replace(/\$+([^$]+)\$+/g, '$1')
        .replace(/【\s*例\s*\d+\s*】/g, '')
        .replace(/[，。；：]/g, match => ({ '，': ',', '。': '.', '；': ';', '：': ':' }[match] || match))
        .replace(/[（]/g, '(')
        .replace(/[）]/g, ')')
        .replace(/[、]/g, ',')
        .replace(/\s+/g, '');
}

function hasAny(text, patterns) {
    return patterns.some(pattern => pattern.test(text));
}

export function classifyGeoGebraProblem(message = '') {
    const text = normalizeGeoGebraProblemText(message);
    const types = [];
    let confidence = 0.2;

    if (hasAny(text, [/轨迹|locus|Locus|动点|中点M|中点.*轨迹/i])) {
        types.push('locus');
        confidence += 0.45;
    }
    if (hasAny(text, [/坐标|圆心|半径|方程|C\(|O\(|x\^2|y\^2|解析几何/i])) {
        types.push('analytic_geometry');
        confidence += 0.25;
    }
    if (hasAny(text, [/三角形|triangle|外接圆|内切圆|垂心|重心|角平分线/i])) {
        types.push('triangle');
        confidence += 0.25;
    }
    if (hasAny(text, [/椭圆|双曲线|抛物线|圆锥曲线|conic|ellipse|hyperbola|parabola/i])) {
        types.push('conic');
        confidence += 0.25;
    }
    if (hasAny(text, [/函数|图像|f\(x\)|y=|function|graph/i])) {
        types.push('function_graph');
        confidence += 0.25;
    }
    if (hasAny(text, [/立体|三维|3D|空间|正方体|球|平面/i])) {
        types.push('solid_geometry');
        confidence += 0.25;
    }
    if (hasAny(text, [/平移|旋转|对称|反射|位似|变换/i])) {
        types.push('transformation');
        confidence += 0.2;
    }

    return {
        primaryType: types[0] || 'unknown',
        types,
        confidence: Math.min(confidence, 0.98),
    };
}

function parsePointDefinitions(text) {
    const points = {};
    const pointPattern = new RegExp(`([A-Z])\\s*\\(\\s*(${NUMBER_PATTERN})\\s*,\\s*(${NUMBER_PATTERN})\\s*\\)`, 'g');
    let match = pointPattern.exec(text);
    while (match) {
        points[match[1]] = {
            x: Number(match[2]),
            y: Number(match[3]),
        };
        match = pointPattern.exec(text);
    }
    return points;
}

function parseCircleFacts(text, points) {
    const circles = [];
    const centerLabel = Object.keys(points).find(label => new RegExp(`圆${label}|以${label}\\(`).test(text)) || 'C';
    const radiusMatch = text.match(new RegExp(`(?:半径(?:为|是|=|:)?|r=)(${NUMBER_PATTERN})`, 'i'))
        || text.match(new RegExp(`(${NUMBER_PATTERN})(?:为|是)?半径`, 'i'));

    if (points[centerLabel] && radiusMatch) {
        circles.push({
            label: 'c',
            centerLabel,
            center: points[centerLabel],
            radius: Number(radiusMatch[1]),
        });
    }

    return circles;
}

export function extractGeoGebraFacts(message = '') {
    const text = normalizeGeoGebraProblemText(message);
    const points = parsePointDefinitions(text);
    if (/(?:过|以|从|在)?(?:坐标)?原点O?|O(?:为|是)(?:坐标)?原点/.test(text) && !points.O) {
        points.O = { x: 0, y: 0 };
    }

    return {
        text,
        points,
        circles: parseCircleFacts(text, points),
        classification: classifyGeoGebraProblem(text),
    };
}

function isCircleChordMidpointLocus(facts) {
    const text = facts.text;
    return facts.circles.length > 0
        && /圆/.test(text)
        && /弦OP|OP/.test(text)
        && /中点M|M的轨迹|轨迹方程/.test(text)
        && facts.points.O?.x === 0
        && facts.points.O?.y === 0;
}

function isPositiveXAxisMaximumAngleProblem(facts) {
    const text = facts.text;
    const pointLabels = Object.keys(facts.points);
    const yAxisPoints = pointLabels.filter(label => {
        const point = facts.points[label];
        return label !== 'P'
            && Math.abs(point.x) < 1e-9
            && point.y > 0;
    });

    return yAxisPoints.length >= 2
        && /P/.test(text)
        && /x轴|x軸|X轴|X軸|x-axis/i.test(text)
        && /正半轴|正半軸|positive/i.test(text)
        && /(∠|angle|角)/i.test(text)
        && /最大|达到最大|max|maximum/i.test(text);
}

function buildPositiveXAxisMaximumAnglePlan(facts) {
    const yAxisPoints = Object.entries(facts.points)
        .filter(([label, point]) => label !== 'P' && Math.abs(point.x) < 1e-9 && point.y > 0)
        .sort((left, right) => left[1].y - right[1].y)
        .slice(0, 2);
    const [[firstLabel, firstPoint], [secondLabel, secondPoint]] = yAxisPoints;
    const product = firstPoint.y * secondPoint.y;
    const optimalX = Math.sqrt(product);
    const exactX = formatRadical(product);
    const maxX = Math.max(optimalX * 2, optimalX + 2, secondPoint.y + 1);
    const demoEndX = Number(formatNumber(Math.max(optimalX * 2, optimalX + 2, 6)));
    const optimalXNumber = Number(formatNumber(optimalX));
    const viewport = {
        xmin: -1,
        ymin: -1,
        xmax: Number(formatNumber(Math.max(maxX + 1, 7))),
        ymax: Number(formatNumber(Math.max(firstPoint.y, secondPoint.y) + 1)),
        equalScale: true,
    };
    const demo = {
        type: 'timeline',
        autoPlay: false,
        clearBeforePlay: true,
        preserveAfterFinish: true,
        durationMs: 6500,
        tracks: [{
            kind: 'move-point',
            movingObject: 'Q',
            samples: 240,
            path: {
                type: 'polyline',
                points: [
                    { x: 0.3, y: 0 },
                    { x: demoEndX, y: 0 },
                    { x: optimalXNumber, y: 0 },
                ],
            },
        }],
    };

    return {
        summary: `已按题意绘制定点 ${firstLabel}(0, ${formatNumber(firstPoint.y)})、${secondLabel}(0, ${formatNumber(secondPoint.y)})，当 P 在 x 轴正半轴且 ∠${firstLabel}P${secondLabel} 最大时，P = (${exactX}, 0) ≈ (${formatNumber(optimalX)}, 0)。`,
        perspective: 'G',
        commands: [
            'O = (0, 0)',
            'X = (1, 0)',
            `${firstLabel} = (0, ${formatNumber(firstPoint.y)})`,
            `${secondLabel} = (0, ${formatNumber(secondPoint.y)})`,
            'positiveXAxis = Ray(O, X)',
            `P = (sqrt(${formatNumber(product)}), 0)`,
            'Q = (0.3, 0)',
            `optA = Segment(P, ${firstLabel})`,
            `optB = Segment(P, ${secondLabel})`,
            `candA = Segment(Q, ${firstLabel})`,
            `candB = Segment(Q, ${secondLabel})`,
            `angP = Angle(${secondLabel}, P, ${firstLabel})`,
            `angQ = Angle(${secondLabel}, Q, ${firstLabel})`,
            'SetColor(positiveXAxis, 0.35, 0.35, 0.35)',
            'SetColor(P, 0.95, 0.35, 0.1)',
            'SetColor(Q, 0, 0.55, 0.85)',
            'SetColor(optA, 0.1, 0.35, 0.95)',
            'SetColor(optB, 0.1, 0.35, 0.95)',
            'SetColor(candA, 0.55, 0.72, 1)',
            'SetColor(candB, 0.55, 0.72, 1)',
            'SetColor(angP, 0.95, 0.35, 0.1)',
            'SetLineThickness(optA, 5)',
            'SetLineThickness(optB, 5)',
            'ShowLabel(O, true)',
            `ShowLabel(${firstLabel}, true)`,
            `ShowLabel(${secondLabel}, true)`,
            'ShowLabel(P, true)',
            'ShowLabel(Q, true)',
            'ShowLabel(angP, true)',
        ],
        viewport,
        constructionPlan: [
            { id: 'known', title: 'Known points and constraint axis', objects: ['O', 'X', firstLabel, secondLabel, 'positiveXAxis'] },
            { id: 'vary', title: 'Move candidate point on positive x-axis', objects: ['Q', 'candA', 'candB', 'angQ'] },
            { id: 'conclusion', title: 'Show maximum angle point', objects: ['P', 'optA', 'optB', 'angP'] },
        ],
        demo,
        validation: { angles: [{ object: 'angP', kind: 'acute' }, { object: 'angQ', kind: 'acute' }] },
        followUp: `演示点 Q 在 x 轴正半轴上移动时，∠${firstLabel}Q${secondLabel} 先增大后减小；最优点 P 的横坐标为 √(${formatNumber(product)}) = ${exactX}。`,
        studioNotes: '确定性题型模板：两点在 y 轴正向、动点 P 在 x 轴正半轴，最大化 ∠APB。由 tan∠APB = x(b-a)/(x^2+ab) 得 x^2=ab。',
        deterministic: true,
        problemType: 'angle_max_on_positive_x_axis',
        extractedFacts: {
            points: facts.points,
            optimalPoint: { x: optimalXNumber, y: 0 },
        },
    };
}

function buildCircleChordMidpointLocusPlan(facts) {
    const circle = facts.circles[0];
    const center = circle.center;
    const radius = circle.radius;
    const locusCenter = {
        x: center.x / 2,
        y: center.y / 2,
    };
    const locusRadius = radius / 2;
    const locusEquation = `${formatSquaredTerm('x', locusCenter.x)} + ${formatSquaredTerm('y', locusCenter.y)} = ${formatNumber(locusRadius ** 2)}`;
    const viewport = {
        xmin: center.x - radius - 1,
        ymin: center.y - radius - 1,
        xmax: center.x + radius + 1,
        ymax: center.y + radius + 1,
        equalScale: true,
    };
    const demo = {
        type: 'timeline',
        autoPlay: false,
        clearBeforePlay: true,
        preserveAfterFinish: true,
        durationMs: 8000,
        tracks: [{
            kind: 'path-trace',
            movingObject: 'P',
            tracedObject: 'M',
            samples: 240,
            path: {
                type: 'circle',
                center: { x: center.x, y: center.y },
                radius,
                startAngle: -90,
                endAngle: 270,
            },
        }],
    };

    return {
        summary: `已按题意绘制圆心 ${circle.centerLabel}(${formatNumber(center.x)}, ${formatNumber(center.y)})、半径 ${formatNumber(radius)} 的圆，并构造弦 OP 的中点 M。M 的轨迹方程为 ${locusEquation}。`,
        perspective: 'G',
        commands: [
            'O = (0, 0)',
            `${circle.centerLabel} = (${formatNumber(center.x)}, ${formatNumber(center.y)})`,
            `${circle.label} = Circle(${circle.centerLabel}, ${formatNumber(radius)})`,
            'P = Point(c)',
            's = Segment(O, P)',
            'M = Midpoint(O, P)',
            `K = (${formatNumber(locusCenter.x)}, ${formatNumber(locusCenter.y)})`,
            `locusM = Circle(K, ${formatNumber(locusRadius)})`,
            'SetColor(c, 0.25, 0.25, 0.25)',
            'SetColor(s, 0.1, 0.35, 0.95)',
            'SetColor(M, 0.95, 0.35, 0.1)',
            'SetColor(locusM, 0, 0.55, 0.85)',
            'SetLineThickness(locusM, 5)',
            'ShowLabel(O, true)',
            `ShowLabel(${circle.centerLabel}, true)`,
            'ShowLabel(P, true)',
            'ShowLabel(M, true)',
            'ShowLabel(K, true)',
        ],
        viewport,
        demo,
        followUp: `拖动点 P，可以看到 M 始终落在以 (${formatNumber(locusCenter.x)}, ${formatNumber(locusCenter.y)}) 为圆心、${formatNumber(locusRadius)} 为半径的轨迹圆上。`,
        studioNotes: '确定性题型模板：圆上动点 P 关于原点 O 缩放 1/2 后得到中点 M，所以轨迹是原圆关于 O 的 1/2 缩放。',
        deterministic: true,
        problemType: 'locus',
        extractedFacts: {
            points: facts.points,
            circles: facts.circles,
            equation: locusEquation,
        },
    };
}

function buildTriangleCircumcirclePlan() {
    return {
        summary: '已绘制可拖动三角形 ABC 及其外接圆。',
        perspective: 'G',
        commands: [
            'A = (-2, 0)',
            'B = (2, 0)',
            'C = (0, 2.4)',
            'tri = Polygon(A, B, C)',
            'circum = Circle(A, B, C)',
            'ShowLabel(A, true)',
            'ShowLabel(B, true)',
            'ShowLabel(C, true)',
            'SetColor(circum, 0, 0.55, 0.85)',
            'SetLineThickness(circum, 4)',
        ],
        followUp: '拖动 A、B、C 可以观察外接圆随三角形变化。',
        studioNotes: '确定性三角形外接圆模板。',
        deterministic: true,
        problemType: 'triangle_circumcircle',
    };
}

function buildTriangleIncirclePlan() {
    return {
        summary: '已绘制可拖动三角形 ABC 及其内切圆。',
        perspective: 'G',
        commands: [
            'A = (-2, 0)',
            'B = (2, 0)',
            'C = (0.4, 2.4)',
            'tri = Polygon(A, B, C)',
            'inc = Incircle(A, B, C)',
            'ShowLabel(A, true)',
            'ShowLabel(B, true)',
            'ShowLabel(C, true)',
            'SetColor(inc, 0.1, 0.6, 0.35)',
            'SetLineThickness(inc, 4)',
        ],
        followUp: '拖动三角形顶点可以观察内切圆如何保持与三边相切。',
        studioNotes: '确定性三角形内切圆模板。',
        deterministic: true,
        problemType: 'triangle_incircle',
    };
}

function extractFunctionExpression(text) {
    const fnMatch = text.match(/(?:f\(x\)=|y=)([^,;，。]+)/i);
    return fnMatch ? fnMatch[1].trim() : '';
}

function buildFunctionGraphPlan(text) {
    const expression = extractFunctionExpression(text);
    if (!expression) return null;
    return {
        summary: `已绘制函数 y = ${expression} 的图像。`,
        perspective: 'G',
        commands: [
            `f(x) = ${expression}`,
            'SetColor(f, 0, 0.45, 0.9)',
            'SetLineThickness(f, 5)',
            'ShowLabel(f, true)',
            'ZoomIn(-5, -5, 5, 5)',
        ],
        followUp: '可以继续要求添加交点、切线、极值或参数滑块。',
        studioNotes: '确定性函数图像模板。',
        deterministic: true,
        problemType: 'function_graph',
    };
}

function buildSolidGeometryPlan(text) {
    if (!/正方体|cube/i.test(text)) return null;
    return {
        summary: '已绘制基础三维正方体模型。',
        perspective: 'T',
        commands: [
            'A = (0, 0, 0)',
            'B = (2, 0, 0)',
            'cube = Cube(A, B)',
            'ShowLabel(A, true)',
            'ShowLabel(B, true)',
        ],
        followUp: '可以继续添加截面、空间角、距离或投影。',
        studioNotes: '确定性基础 3D 模板。',
        deterministic: true,
        problemType: 'solid_geometry',
    };
}

export function tryCreateGeoGebraProblemPlan(requestPayload = {}) {
    const message = String(requestPayload.message || '');
    const facts = extractGeoGebraFacts(message);
    const text = facts.text;

    if (isCircleChordMidpointLocus(facts)) {
        return buildCircleChordMidpointLocusPlan(facts);
    }
    if (isPositiveXAxisMaximumAngleProblem(facts)) {
        return buildPositiveXAxisMaximumAnglePlan(facts);
    }
    if (/三角形|triangle/i.test(text) && /外接圆|circumcircle/i.test(text)) {
        return buildTriangleCircumcirclePlan();
    }
    if (/三角形|triangle/i.test(text) && /内切圆|incircle/i.test(text)) {
        return buildTriangleIncirclePlan();
    }
    if (isFermatPointProblem(text)) {
        return buildFermatPointPlan();
    }
    const functionPlan = buildFunctionGraphPlan(text);
    if (functionPlan) return functionPlan;
    const solidPlan = buildSolidGeometryPlan(text);
    if (solidPlan) return solidPlan;

    return null;
}

function isFermatPointProblem(text) {
    return /三角形|triangle/i.test(text)
        && (/费马|fermat|PA\+PB\+PC|PA\s*\+\s*PB\s*\+\s*PC|距离之和|距离和/i.test(text)
            || (/最小|minimum|最短/i.test(text) && /PA|PB|PC|距离/i.test(text)));
}

function buildFermatPointPlan() {
    return {
        summary: '已构造三角形 ABC 的费马点 P（PA+PB+PC 最小的点），使用向外作等边三角形的经典方法。拖动 A、B、C 可动态观察费马点位置。',
        perspective: 'G',
        commands: [
            'A = (0, 0)',
            'B = (4, 0)',
            'C = (1, 3)',
            'poly1 = Polygon(A, B, C)',
            // Construct equilateral triangles outward on two sides
            'D = Rotate(A, -60°, B)',
            'E = Rotate(B, 60°, A)',
            // Fermat point is intersection of CD and AE diagonals (renamed to avoid confusion)
            'lineCD = Segment(C, D)',
            'lineAE = Segment(A, D)',
            // Actually: Fermat point = intersection of lines from new vertex to opposite original vertex
            // Method: build equilateral triangle on AB → vertex D, on AC → vertex E
            // Then P = Intersect(Line(C,D), Line(B,E))
            // Correct construction:
            'lineF1 = Line(C, D)',
            'F = Rotate(A, 60°, C)',
            'lineF2 = Line(B, F)',
            'P = Intersect(lineF1, lineF2)',
            // Distance sum
            'segPA = Segment(P, A)',
            'segPB = Segment(P, B)',
            'segPC = Segment(P, C)',
            'total = Distance(P, A) + Distance(P, B) + Distance(P, C)',
            'txtSum = Text("PA+PB+PC = " + FormatNumber(total, 2), (3.5, 3.5), true, true)',
            // Visual styling
            'SetColor(poly1, 0.9, 0.9, 0.95)',
            'SetColor(P, 0.95, 0.2, 0.1)',
            'SetPointSize(P, 7)',
            'SetColor(segPA, 0.55, 0.72, 1)',
            'SetColor(segPB, 0.55, 0.72, 1)',
            'SetColor(segPC, 0.55, 0.72, 1)',
            'SetLineStyle(lineCD, 1)',
            'SetColor(lineCD, 0.8, 0.8, 0.8)',
            'SetLineStyle(lineF1, 1)',
            'SetColor(lineF1, 0.8, 0.8, 0.8)',
            'SetLineStyle(lineF2, 1)',
            'SetColor(lineF2, 0.8, 0.8, 0.8)',
            'SetVisible(lineCD, false)',
            'SetVisible(lineAE, false)',
            'SetVisible(lineF1, false)',
            'SetVisible(lineF2, false)',
            'SetVisible(D, false)',
            'SetVisible(F, false)',
            // Labels
            'ShowLabel(A, true)',
            'ShowLabel(B, true)',
            'ShowLabel(C, true)',
            'ShowLabel(P, true)',
            'SetCaption(P, "费马点")',
        ],
        viewport: { xmin: -2, ymin: -2, xmax: 6, ymax: 5, equalScale: true },
        followUp: '拖动 A、B、C 三个顶点可以动态观察费马点 P 的位置变化和 PA+PB+PC 的值。当某个角 ≥ 120° 时，费马点会退化到该顶点。',
        studioNotes: '确定性费马点模板：在 AB、AC 外侧各作等边三角形，费马点 P 为对角线交点。',
        deterministic: true,
        problemType: 'fermat_point',
    };
}
