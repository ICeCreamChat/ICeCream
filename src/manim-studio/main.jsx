import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Stage, Layer, Image as KonvaImage, Rect, Text, Group, Arrow } from 'react-konva';
import { create } from 'zustand';

const FRAME_RATIO = 16 / 9;
const MIN_BOX_SIZE = 0.012;

const ui = {
    select: '\u9009\u62e9',
    boxSelect: '\u6846\u9009',
    manual: '\u624b\u52a8\u753b\u6846',
    addText: '\u6dfb\u52a0\u6587\u5b57',
    addFormula: '\u6dfb\u52a0\u516c\u5f0f',
    addArrow: '\u6dfb\u52a0\u7bad\u5934',
    delete: '\u5220\u9664',
    apply: '\u5e94\u7528\u5230\u6574\u6bb5\u52a8\u753b',
    canvasHint: '\u9009\u4e2d\u540e\u53ef\u76f4\u63a5\u62d6\u52a8\uff0c\u4fee\u6539\u4f1a\u5728\u753b\u5e03\u4e0a\u5148\u9884\u89c8',
    inspectorTitle: '\u5df2\u9009\u5bf9\u8c61',
    noSelection: '\u5728\u753b\u5e03\u4e0a\u9009\u62e9\u5bf9\u8c61\uff0c\u6216\u624b\u52a8\u753b\u6846\u6807\u6ce8\u6f0f\u8bc6\u522b\u533a\u57df\u3002',
    commandLabel: '\u7528\u81ea\u7136\u8bed\u8a00\u63cf\u8ff0\u4f60\u60f3\u600e\u4e48\u6539',
    commandPlaceholder: '\u4f8b\u5982\uff1a\u628a\u8fd9\u4e9b\u6807\u7b7e\u6392\u5f00\uff0c\u7f29\u5c0f\u4e00\u70b9\uff0c\u6539\u6210\u6df1\u84dd\u8272\uff0c\u4e0d\u8981\u6321\u4f4f\u66f2\u7ebf',
    frameMissing: '\u5173\u952e\u5e27\u56fe\u7247\u6682\u4e0d\u53ef\u7528',
    frameMissingHelp: '\u53ef\u4ee5\u91cd\u65b0\u8fd0\u884c\u62bd\u5e27\uff0c\u6216\u5148\u4f7f\u7528\u624b\u52a8\u753b\u6846\u7ea6\u675f\u5e03\u5c40\u3002',
    selected: '\u5df2\u9009',
    objects: '\u4e2a\u5bf9\u8c61',
    pending: '\u6709\u672a\u5e94\u7528\u7684\u753b\u5e03\u4fee\u6539',
    idle: '\u6682\u65e0\u5f85\u5e94\u7528\u4fee\u6539',
    text: '\u6587\u5b57',
    formula: '\u516c\u5f0f',
    arrow: '\u7bad\u5934',
    region: '\u624b\u52a8\u533a\u57df',
    newText: '\u65b0\u589e\u6587\u5b57',
    newFormula: '\u65b0\u589e\u516c\u5f0f',
    newArrow: '\u65b0\u589e\u7bad\u5934',
};

const toolOptions = [
    ['select', ui.select],
    ['box-select', ui.boxSelect],
    ['manual', ui.manual],
    ['add_text', ui.addText],
    ['add_formula', ui.addFormula],
    ['add_arrow', ui.addArrow],
];

const typeLabels = {
    text: ui.text,
    safetext: ui.text,
    formula: ui.formula,
    math: ui.formula,
    mathtex: ui.formula,
    safemathtex: ui.formula,
    point: '\u5173\u952e\u70b9',
    dot: '\u5173\u952e\u70b9',
    curve: '\u66f2\u7ebf',
    graph: '\u56fe\u5f62',
    arrow: ui.arrow,
    line: '\u7ebf\u6bb5',
    axes: '\u5750\u6807\u7cfb',
    axis: '\u5750\u6807\u8f74',
    panel: '\u9762\u677f',
    rectangle: '\u9762\u677f',
    manual: ui.region,
    new: '\u65b0\u589e\u5bf9\u8c61',
};

const typePriority = {
    text: 100,
    safetext: 100,
    formula: 96,
    mathtex: 96,
    safemathtex: 96,
    point: 90,
    dot: 90,
    label: 88,
    curve: 74,
    arrow: 72,
    line: 70,
    axes: 52,
    axis: 52,
    graph: 48,
    shape: 46,
    panel: 12,
    rectangle: 12,
    background: 0,
};

const useCanvasStore = create((set, get) => ({
    selectedObjectIds: [],
    objectBoxOverrides: {},
    objectEdits: {},
    newObjects: [],
    deletedObjectIds: [],
    manualReferenceRegions: [],
    naturalLanguageCommand: '',
    tool: 'select',
    marquee: null,
    dragSession: null,
    statusMessage: '',
    setTool: (tool) => set({ tool, marquee: null, dragSession: null, statusMessage: '' }),
    setCommand: (naturalLanguageCommand) => set({ naturalLanguageCommand }),
    clearSelection: () => set({ selectedObjectIds: [], marquee: null, statusMessage: '' }),
    resetFrameInteraction: () => set({ selectedObjectIds: [], marquee: null, dragSession: null, statusMessage: '' }),
    resetDraft: () => set({
        selectedObjectIds: [],
        objectBoxOverrides: {},
        objectEdits: {},
        newObjects: [],
        deletedObjectIds: [],
        manualReferenceRegions: [],
        naturalLanguageCommand: '',
        marquee: null,
        dragSession: null,
        statusMessage: '',
    }),
    selectObject: (id, mode = 'replace') => {
        const objectId = String(id || '');
        if (!objectId) return;
        const current = new Set(get().selectedObjectIds);
        if (mode === 'toggle') {
            if (current.has(objectId)) current.delete(objectId);
            else current.add(objectId);
            set({ selectedObjectIds: [...current], statusMessage: '' });
            return;
        }
        if (mode === 'add') {
            current.add(objectId);
            set({ selectedObjectIds: [...current], statusMessage: '' });
            return;
        }
        set({ selectedObjectIds: [objectId], statusMessage: '' });
    },
    selectObjects: (ids, mode = 'replace') => {
        const nextIds = [...new Set((ids || []).map(String).filter(Boolean))];
        if (mode === 'toggle') {
            const current = new Set(get().selectedObjectIds);
            nextIds.forEach(id => current.has(id) ? current.delete(id) : current.add(id));
            set({ selectedObjectIds: [...current], statusMessage: '' });
            return;
        }
        set({ selectedObjectIds: nextIds, statusMessage: '' });
    },
    beginDrag: (objectIds, startPoint, boxes) => set({
        dragSession: {
            objectIds: [...new Set((objectIds || []).map(String).filter(Boolean))],
            startPoint,
            boxes,
        },
        statusMessage: '',
    }),
    updateDrag: (point, objectsById, frame) => {
        const state = get();
        const session = state.dragSession;
        if (!session) return;
        const dx = point.x - session.startPoint.x;
        const dy = point.y - session.startPoint.y;
        const nextOverrides = { ...state.objectBoxOverrides };
        const nextEdits = { ...state.objectEdits };
        let nextNewObjects = state.newObjects;
        let nextManualRegions = state.manualReferenceRegions;
        session.objectIds.forEach(id => {
            const startBox = session.boxes[id];
            if (!startBox) return;
            const bbox = clampBox({
                x: startBox.x + dx,
                y: startBox.y + dy,
                width: startBox.width,
                height: startBox.height,
            });
            nextOverrides[id] = bbox;
            if (id.startsWith('new_')) {
                nextNewObjects = nextNewObjects.map(item => String(item.id) === id ? { ...item, bbox, normalizedBBox: bbox } : item);
            } else if (id.startsWith('manual_')) {
                nextManualRegions = nextManualRegions.map(item => String(item.id) === id ? { ...item, bbox, normalizedBBox: bbox } : item);
            } else {
                const object = objectsById.get(id);
                nextEdits[id] = {
                    operation: 'layout_calibrate',
                    objectId: id,
                    sourceBBox: object?.originalBBox || object?.bbox || startBox,
                    normalizedBBox: bbox,
                    baseFrameId: frame?.frameId || '',
                    baseTime: Number(frame?.time || 0),
                };
            }
        });
        set({
            objectBoxOverrides: nextOverrides,
            objectEdits: nextEdits,
            newObjects: nextNewObjects,
            manualReferenceRegions: nextManualRegions,
            statusMessage: ui.pending,
        });
    },
    endDrag: () => set({ dragSession: null }),
    setMarquee: (marquee) => set({ marquee }),
    markDeleted: (ids) => {
        const nextIds = [...new Set((ids || get().selectedObjectIds).map(String).filter(Boolean))];
        if (!nextIds.length) return;
        set((state) => {
            const deleted = new Set(state.deletedObjectIds);
            nextIds.forEach(id => {
                if (!id.startsWith('new_') && !id.startsWith('manual_')) deleted.add(id);
            });
            return {
                deletedObjectIds: [...deleted],
                newObjects: state.newObjects.filter(item => !nextIds.includes(String(item.id))),
                manualReferenceRegions: state.manualReferenceRegions.filter(item => !nextIds.includes(String(item.id))),
                selectedObjectIds: [],
                statusMessage: ui.pending,
            };
        });
    },
    addNewObject: (kind, point, frame) => {
        const preset = getNewPreset(kind);
        const id = `new_${kind}_${Date.now()}_${Math.round(Math.random() * 1000)}`;
        const bbox = clampBox({
            x: point.x - preset.width / 2,
            y: point.y - preset.height / 2,
            width: preset.width,
            height: preset.height,
        });
        const object = {
            id,
            kind,
            type: preset.type,
            role: preset.role,
            label: preset.label,
            text: preset.text,
            bbox,
            normalizedBBox: bbox,
            baseFrameId: frame?.frameId || '',
            baseTime: Number(frame?.time || 0),
            isNewObject: true,
        };
        set((state) => ({
            newObjects: [...state.newObjects, object],
            selectedObjectIds: [id],
            statusMessage: ui.pending,
        }));
    },
    addManualRegion: (bbox, frame) => {
        const id = `manual_${Date.now()}_${Math.round(Math.random() * 1000)}`;
        const normalizedBBox = clampBox(bbox);
        const region = {
            id,
            type: 'manual',
            role: 'manual',
            label: ui.region,
            bbox: normalizedBBox,
            normalizedBBox,
            baseFrameId: frame?.frameId || '',
            baseTime: Number(frame?.time || 0),
        };
        set((state) => ({
            manualReferenceRegions: [...state.manualReferenceRegions, region],
            selectedObjectIds: [id],
            statusMessage: ui.pending,
        }));
    },
}));

function clampBox(input) {
    const rawX = Number(input?.x) || 0;
    const rawY = Number(input?.y) || 0;
    const rawW = Number(input?.width) || 0.08;
    const rawH = Number(input?.height) || 0.05;
    const width = Math.max(MIN_BOX_SIZE, Math.min(1, rawW));
    const height = Math.max(MIN_BOX_SIZE, Math.min(1, rawH));
    const x = Math.max(0, Math.min(1 - width, rawX));
    const y = Math.max(0, Math.min(1 - height, rawY));
    return { x, y, width, height };
}

function boxUnion(boxes) {
    const valid = (boxes || []).filter(Boolean);
    if (!valid.length) return null;
    const left = Math.min(...valid.map(box => box.x));
    const top = Math.min(...valid.map(box => box.y));
    const right = Math.max(...valid.map(box => box.x + box.width));
    const bottom = Math.max(...valid.map(box => box.y + box.height));
    return clampBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function boxesIntersect(a, b) {
    if (!a || !b) return false;
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function getNewPreset(kind) {
    const presets = {
        add_text: { label: ui.newText, type: 'Text', role: 'text', width: 0.2, height: 0.06, text: ui.newText },
        add_formula: { label: ui.newFormula, type: 'MathTex', role: 'formula', width: 0.18, height: 0.06, text: 'x' },
        add_arrow: { label: ui.newArrow, type: 'Arrow', role: 'arrow', width: 0.22, height: 0.04, text: '' },
    };
    return presets[kind] || presets.add_text;
}

function normalizeType(value = '') {
    return String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '');
}

function getTypeLabel(object) {
    const type = normalizeType(object?.role || object?.kind || object?.type || object?.className);
    return typeLabels[type] || object?.typeLabel || '\u5bf9\u8c61';
}

function getObjectPriority(object) {
    const type = normalizeType(object?.role || object?.kind || object?.type || object?.className);
    return typePriority[type] ?? 35;
}

function getObjectName(object) {
    return String(object?.displayName || object?.label || object?.text || object?.name || object?.id || '\u672a\u547d\u540d\u5bf9\u8c61');
}

function getObjectBoxForFrame(object, frame) {
    const frameId = String(frame?.frameId || '');
    const time = Number(frame?.time || 0);
    const candidates = [];
    if (Array.isArray(object?.bboxes)) candidates.push(...object.bboxes);
    if (object?.bbox) candidates.push({ bbox: object.bbox });
    if (object?.normalizedBBox) candidates.push({ bbox: object.normalizedBBox });
    if (!candidates.length) return null;

    const exact = candidates.find(item => String(item.frameId || '') && String(item.frameId) === frameId);
    if (exact) return normalizeRawBox(exact.bbox || exact);
    const timed = candidates.find(item => {
        if (!Array.isArray(item.timeRange) || item.timeRange.length < 2) return false;
        return time >= Number(item.timeRange[0]) && time <= Number(item.timeRange[1]);
    });
    if (timed) return normalizeRawBox(timed.bbox || timed);
    return normalizeRawBox(candidates[0].bbox || candidates[0]);
}

function normalizeRawBox(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) {
        if (raw.length >= 4) {
            const [x, y, width, height] = raw.map(Number);
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
                return clampBox({ x, y, width, height });
            }
        }
        return null;
    }
    return clampBox({
        x: raw.x ?? raw.left ?? raw.x0 ?? 0,
        y: raw.y ?? raw.top ?? raw.y0 ?? 0,
        width: raw.width ?? raw.w ?? ((raw.x1 ?? 0) - (raw.x0 ?? 0)),
        height: raw.height ?? raw.h ?? ((raw.y1 ?? 0) - (raw.y0 ?? 0)),
    });
}

function normalizeFrameSet(frameSet = {}, selectedFrameId = '') {
    const frames = Array.isArray(frameSet.frames) ? frameSet.frames : [];
    const recommended = frameSet.recommendedFrameId || selectedFrameId || frames[0]?.frameId || '';
    return {
        frames,
        recommendedFrameId: recommended,
    };
}

function useElementSize(ref) {
    const [size, setSize] = useState({ width: 720, height: 405 });
    useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        const update = () => {
            const width = Math.max(360, node.clientWidth || 720);
            setSize({ width, height: Math.max(240, width / FRAME_RATIO) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

function useImage(src) {
    const [image, setImage] = useState(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (!src) {
            setImage(null);
            setFailed(false);
            return undefined;
        }
        let cancelled = false;
        setImage(null);
        setFailed(false);
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (!cancelled) {
                setImage(img);
                setFailed(false);
            }
        };
        img.onerror = () => {
            if (!cancelled) {
                setImage(null);
                setFailed(true);
            }
        };
        img.src = src;
        return () => {
            cancelled = true;
        };
    }, [src]);
    return { image, failed };
}

function buildExportState(state, objectsById, selectedFrame) {
    const selectedObjectIds = state.selectedObjectIds || [];
    const selectedObjectSnapshots = selectedObjectIds.map(id => {
        const object = objectsById.get(String(id));
        return object ? {
            ...object,
            bbox: object.bbox,
            normalizedBBox: object.bbox,
        } : null;
    }).filter(Boolean);
    const selectedBoxes = selectedObjectIds.map(id => state.objectBoxOverrides[id] || objectsById.get(String(id))?.bbox).filter(Boolean);
    const objectEdits = Object.values(state.objectEdits || {});
    const baseFrameId = selectedFrame?.frameId || '';
    const baseTime = Number(selectedFrame?.time || 0);
    return {
        baseFrameId,
        baseTime,
        selectedObjectIds,
        selectedObjectSnapshots,
        selectionBBox: boxUnion(selectedBoxes),
        objectEdits,
        pendingObjectEdits: objectEdits,
        objectBoxOverrides: Object.entries(state.objectBoxOverrides || {}).map(([objectId, bbox]) => ({ objectId, bbox, normalizedBBox: bbox })),
        newObjects: state.newObjects || [],
        pendingNewObjects: state.newObjects || [],
        deletedObjectIds: state.deletedObjectIds || [],
        pendingDeletes: state.deletedObjectIds || [],
        manualReferenceRegions: state.manualReferenceRegions || [],
        manualRegions: state.manualReferenceRegions || [],
        naturalLanguageCommand: state.naturalLanguageCommand || '',
        naturalLanguageEdit: {
            command: state.naturalLanguageCommand || '',
            selectionMode: selectedObjectIds.length > 1 ? 'multi' : selectedObjectIds.length === 1 ? 'single' : 'canvas',
            selectedObjectId: selectedObjectIds[0] || '',
            selectedObjectIds,
            selectedObjectSnapshot: selectedObjectSnapshots[0] || null,
            selectedObjectSnapshots,
            baseFrameId,
            baseTime,
        },
        tool: state.tool,
    };
}

function FrameToolbar({ tool, hasDraft, onTool, onDelete, onApply }) {
    return (
        <div className="studio-konva-toolbar">
            {toolOptions.map(([id, label]) => (
                <button
                    key={id}
                    type="button"
                    className={tool === id ? 'is-active' : ''}
                    onClick={() => onTool(id)}
                >
                    {label}
                </button>
            ))}
            <span className="studio-konva-toolbar-spacer" />
            <button type="button" onClick={onDelete}>{ui.delete}</button>
            <button type="button" className="primary" disabled={!hasDraft} onClick={onApply}>{ui.apply}</button>
        </div>
    );
}

function CanvasObject({ object, image, size, selected, hover, onPointerDown, onPointerEnter, onPointerLeave }) {
    const box = object.bbox;
    const x = box.x * size.width;
    const y = box.y * size.height;
    const width = box.width * size.width;
    const height = box.height * size.height;
    const type = normalizeType(object.role || object.kind || object.type);
    const showProxyImage = image && object.sourceBBox && (selected || object.hasOverride || hover);
    const crop = showProxyImage ? {
        x: object.sourceBBox.x * image.width,
        y: object.sourceBBox.y * image.height,
        width: Math.max(1, object.sourceBBox.width * image.width),
        height: Math.max(1, object.sourceBBox.height * image.height),
    } : null;
    const label = getObjectName(object);
    const color = selected ? '#0284C7' : hover ? '#38BDF8' : '#0EA5E9';
    return (
        <Group
            x={x}
            y={y}
            onPointerDown={onPointerDown}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
        >
            {showProxyImage ? (
                <KonvaImage
                    image={image}
                    crop={crop}
                    width={width}
                    height={height}
                    opacity={0.96}
                />
            ) : null}
            {object.isNewObject && type !== 'arrow' ? (
                <Text
                    text={object.text || label}
                    fontSize={Math.max(12, Math.min(22, height * 0.42))}
                    fontStyle="bold"
                    fill="#1D2530"
                    width={width}
                    height={height}
                    align="center"
                    verticalAlign="middle"
                />
            ) : null}
            {object.isNewObject && type === 'arrow' ? (
                <Arrow
                    points={[4, height / 2, Math.max(8, width - 4), height / 2]}
                    stroke="#0284C7"
                    fill="#0284C7"
                    strokeWidth={3}
                    pointerLength={10}
                    pointerWidth={8}
                />
            ) : null}
            <Rect
                width={width}
                height={height}
                fill={selected || hover ? 'rgba(14, 165, 233, 0.08)' : 'rgba(14, 165, 233, 0.005)'}
                stroke={selected || hover || object.isNewObject || object.isManual ? color : 'rgba(14, 165, 233, 0.0)'}
                strokeWidth={selected ? 2 : 1.4}
                dash={object.isManual ? [7, 5] : selected || hover ? [5, 4] : []}
                cornerRadius={6}
            />
            {(selected || hover) ? (
                <Text
                    text={label}
                    x={0}
                    y={-24}
                    fontFamily="Inter, Microsoft YaHei, system-ui, sans-serif"
                    fontSize={12}
                    fontStyle="bold"
                    fill="#075985"
                    padding={5}
                    width={Math.min(Math.max(width, 88), 220)}
                    wrap="none"
                    ellipsis
                />
            ) : null}
        </Group>
    );
}

function Inspector({ state, objectsById, onCommand, onChip, onApply }) {
    const selected = (state.selectedObjectIds || []).map(id => objectsById.get(String(id))).filter(Boolean);
    const hasDraft = hasDraftState(state);
    return (
        <div className="studio-konva-inspector">
            <div className="studio-konva-inspector-head">
                <div>
                    <span>{ui.inspectorTitle}</span>
                    <strong>{selected.length ? `${selected.length} ${ui.objects}` : ui.noSelection}</strong>
                </div>
                <small>{hasDraft ? ui.pending : ui.idle}</small>
            </div>
            {selected.length ? (
                <div className="studio-konva-selected-list">
                    {selected.slice(0, 8).map(item => (
                        <span key={item.id} className="studio-konva-selected-chip">
                            {getObjectName(item)}
                            <em>{getTypeLabel(item)}</em>
                        </span>
                    ))}
                    {selected.length > 8 ? <span className="studio-konva-selected-chip">+{selected.length - 8}</span> : null}
                </div>
            ) : null}
            <label className="studio-konva-command">
                <span>{ui.commandLabel}</span>
                <textarea
                    value={state.naturalLanguageCommand || ''}
                    placeholder={ui.commandPlaceholder}
                    onChange={event => onCommand(event.target.value)}
                />
            </label>
            <div className="studio-konva-quick-chips">
                {[
                    '\u5f80\u4e0a\u79fb\u4e00\u70b9',
                    '\u6574\u4f53\u7f29\u5c0f\u4e00\u70b9',
                    '\u6539\u6210\u6df1\u84dd\u8272',
                    '\u8fd9\u4e9b\u6587\u5b57\u6392\u5f00\uff0c\u4e0d\u8981\u76f8\u4e92\u906e\u4f4f',
                    '\u5220\u9664\u8fd9\u4e9b\u5bf9\u8c61',
                ].map(text => (
                    <button key={text} type="button" onClick={() => onChip(text)}>{text}</button>
                ))}
            </div>
            <div className="studio-konva-inspector-actions">
                <button type="button" className="primary" disabled={!hasDraft} onClick={onApply}>{ui.apply}</button>
            </div>
        </div>
    );
}

function hasDraftState(state) {
    return Boolean(
        Object.keys(state.objectEdits || {}).length ||
        Object.keys(state.objectBoxOverrides || {}).length ||
        (state.newObjects || []).length ||
        (state.deletedObjectIds || []).length ||
        (state.manualReferenceRegions || []).length ||
        String(state.naturalLanguageCommand || '').trim()
    );
}

function StudioCanvasApp(props) {
    const {
        studioRevision = 0,
        manifest,
        frameSet,
        selectedFrameId,
        recommendedFrameId,
        videoUrl = '',
        onFrameChange,
        onDraftChange,
        onSelectionChange,
        onApply,
    } = props;
    const rootRef = useRef(null);
    const stageRef = useRef(null);
    const size = useElementSize(rootRef);
    const frameData = useMemo(() => normalizeFrameSet(frameSet, selectedFrameId || recommendedFrameId), [frameSet, selectedFrameId, recommendedFrameId, studioRevision, videoUrl]);
    const [activeFrameId, setActiveFrameId] = useState(selectedFrameId || recommendedFrameId || frameData.recommendedFrameId);
    const activeFrame = useMemo(() => {
        return frameData.frames.find(item => String(item.frameId) === String(activeFrameId))
            || frameData.frames.find(item => String(item.frameId) === String(frameData.recommendedFrameId))
            || frameData.frames[0]
            || null;
    }, [activeFrameId, frameData]);
    const imageUrl = activeFrame?.imageUrl || activeFrame?.url || '';
    const { image, failed } = useImage(imageUrl);
    const state = useCanvasStore();
    const selectedSet = useMemo(() => new Set(state.selectedObjectIds.map(String)), [state.selectedObjectIds]);
    const [hoverId, setHoverId] = useState('');
    const [pointerStart, setPointerStart] = useState(null);

    useEffect(() => {
        const nextFrameId = selectedFrameId || frameData.recommendedFrameId || frameData.frames[0]?.frameId || '';
        setActiveFrameId(nextFrameId);
        setHoverId('');
        setPointerStart(null);
        useCanvasStore.getState().resetDraft();
    }, [studioRevision, videoUrl, frameData.recommendedFrameId]);

    useEffect(() => {
        if (selectedFrameId) setActiveFrameId(selectedFrameId);
    }, [selectedFrameId]);

    useEffect(() => {
        state.resetFrameInteraction();
        onFrameChange?.(activeFrame?.frameId || '');
    }, [activeFrame?.frameId]);

    const manifestObjects = useMemo(() => {
        const raw = Array.isArray(manifest?.objects) ? manifest.objects : [];
        const frameObjectIds = Array.isArray(activeFrame?.objectIds) ? new Set(activeFrame.objectIds.map(String)) : null;
        return raw
            .map(item => {
                const id = String(item.id || item.objectId || item.name || '');
                if (!id) return null;
                if (frameObjectIds && !frameObjectIds.has(id)) return null;
                const sourceBBox = getObjectBoxForFrame(item, activeFrame);
                if (!sourceBBox) return null;
                const bbox = state.objectBoxOverrides[id] || sourceBBox;
                return {
                    ...item,
                    id,
                    bbox,
                    originalBBox: sourceBBox,
                    sourceBBox,
                    label: getObjectName(item),
                    priority: getObjectPriority(item),
                    hasOverride: Boolean(state.objectBoxOverrides[id]),
                };
            })
            .filter(Boolean)
            .filter(item => !state.deletedObjectIds.includes(String(item.id)))
            .sort((a, b) => (a.priority - b.priority) || ((a.bbox.width * a.bbox.height) - (b.bbox.width * b.bbox.height)));
    }, [manifest, activeFrame, state.objectBoxOverrides, state.deletedObjectIds]);

    const allObjects = useMemo(() => {
        const newObjects = (state.newObjects || []).map(item => ({
            ...item,
            id: String(item.id),
            bbox: state.objectBoxOverrides[String(item.id)] || item.normalizedBBox || item.bbox,
            originalBBox: item.normalizedBBox || item.bbox,
            sourceBBox: item.normalizedBBox || item.bbox,
            label: item.label || item.text || ui.newText,
            priority: 100,
            isNewObject: true,
        }));
        const manual = (state.manualReferenceRegions || []).map(item => ({
            ...item,
            id: String(item.id),
            bbox: state.objectBoxOverrides[String(item.id)] || item.normalizedBBox || item.bbox,
            originalBBox: item.normalizedBBox || item.bbox,
            sourceBBox: item.normalizedBBox || item.bbox,
            label: item.label || ui.region,
            priority: 98,
            isManual: true,
        }));
        return [...manifestObjects, ...newObjects, ...manual];
    }, [manifestObjects, state.newObjects, state.manualReferenceRegions, state.objectBoxOverrides]);

    const objectsById = useMemo(() => new Map(allObjects.map(item => [String(item.id), item])), [allObjects]);

    useEffect(() => {
        onDraftChange?.(buildExportState(useCanvasStore.getState(), objectsById, activeFrame));
    }, [
        state.selectedObjectIds,
        state.objectBoxOverrides,
        state.objectEdits,
        state.newObjects,
        state.deletedObjectIds,
        state.manualReferenceRegions,
        state.naturalLanguageCommand,
        activeFrame,
        objectsById,
    ]);

    useEffect(() => {
        onSelectionChange?.({
            selectedObjectIds: state.selectedObjectIds,
            selectedObjects: state.selectedObjectIds.map(id => objectsById.get(String(id))).filter(Boolean),
        });
    }, [state.selectedObjectIds, objectsById]);

    const stagePoint = useCallback(() => {
        const stage = stageRef.current;
        const pointer = stage?.getPointerPosition?.();
        if (!pointer) return null;
        return { x: pointer.x / size.width, y: pointer.y / size.height };
    }, [size.width, size.height]);

    const handleObjectPointerDown = useCallback((event, object) => {
        event.cancelBubble = true;
        const mode = event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey ? 'toggle' : 'replace';
        const ids = mode === 'replace' && selectedSet.has(String(object.id)) && state.selectedObjectIds.length > 1
            ? state.selectedObjectIds
            : [String(object.id)];
        state.selectObject(object.id, mode);
        const selectedIds = mode === 'replace' && selectedSet.has(String(object.id)) ? state.selectedObjectIds : ids;
        const boxes = {};
        selectedIds.forEach(id => {
            const target = objectsById.get(String(id));
            if (target?.bbox) boxes[String(id)] = target.bbox;
        });
        const point = stagePoint();
        if (point) state.beginDrag(selectedIds, point, boxes);
    }, [objectsById, selectedSet, stagePoint, state]);

    const handleStagePointerDown = useCallback((event) => {
        if (event.target !== event.target.getStage()) return;
        const point = stagePoint();
        if (!point) return;
        if (state.tool === 'box-select' || state.tool === 'manual') {
            setPointerStart(point);
            state.setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
            return;
        }
        if (state.tool === 'add_text' || state.tool === 'add_formula' || state.tool === 'add_arrow') {
            state.addNewObject(state.tool, point, activeFrame);
            state.setTool('select');
            return;
        }
        if (!event.evt.shiftKey && !event.evt.ctrlKey && !event.evt.metaKey) state.clearSelection();
    }, [activeFrame, stagePoint, state]);

    const handleStagePointerMove = useCallback(() => {
        const point = stagePoint();
        if (!point) return;
        if (useCanvasStore.getState().dragSession) {
            state.updateDrag(point, objectsById, activeFrame);
            return;
        }
        if (pointerStart && (state.tool === 'box-select' || state.tool === 'manual')) {
            const x = Math.min(pointerStart.x, point.x);
            const y = Math.min(pointerStart.y, point.y);
            state.setMarquee(clampBox({
                x,
                y,
                width: Math.abs(point.x - pointerStart.x),
                height: Math.abs(point.y - pointerStart.y),
            }));
        }
    }, [activeFrame, objectsById, pointerStart, stagePoint, state]);

    const handleStagePointerUp = useCallback(() => {
        const current = useCanvasStore.getState();
        if (current.dragSession) {
            state.endDrag();
            return;
        }
        if (pointerStart && current.marquee) {
            const box = current.marquee;
            if (box.width > 0.01 && box.height > 0.01) {
                if (state.tool === 'manual') {
                    state.addManualRegion(box, activeFrame);
                } else {
                    const ids = allObjects.filter(item => boxesIntersect(item.bbox, box)).map(item => item.id);
                    state.selectObjects(ids, 'replace');
                }
            }
        }
        setPointerStart(null);
        state.setMarquee(null);
    }, [activeFrame, allObjects, pointerStart, state]);

    const handleDelete = useCallback(() => state.markDeleted(), [state]);
    const handleApply = useCallback(() => {
        onApply?.(buildExportState(useCanvasStore.getState(), objectsById, activeFrame));
    }, [activeFrame, objectsById, onApply]);

    const hasDraft = hasDraftState(state);
    const selectedBoxes = state.selectedObjectIds.map(id => objectsById.get(String(id))?.bbox).filter(Boolean);
    const selectionBox = boxUnion(selectedBoxes);

    return (
        <div className="manim-studio-canvas-app">
            <FrameToolbar
                tool={state.tool}
                hasDraft={hasDraft}
                onTool={state.setTool}
                onDelete={handleDelete}
                onApply={handleApply}
            />
            <div className="studio-konva-stage-shell" ref={rootRef}>
                {!image || failed ? (
                    <div className="studio-konva-empty">
                        <strong>{ui.frameMissing}</strong>
                        <span>{ui.frameMissingHelp}</span>
                    </div>
                ) : (
                    <Stage
                        ref={stageRef}
                        width={size.width}
                        height={size.height}
                        onPointerDown={handleStagePointerDown}
                        onPointerMove={handleStagePointerMove}
                        onPointerUp={handleStagePointerUp}
                        onPointerLeave={handleStagePointerUp}
                    >
                        <Layer listening={false}>
                            <KonvaImage image={image} x={0} y={0} width={size.width} height={size.height} />
                        </Layer>
                        <Layer>
                            {allObjects.map(object => (
                                <CanvasObject
                                    key={object.id}
                                    object={object}
                                    image={image}
                                    size={size}
                                    selected={selectedSet.has(String(object.id))}
                                    hover={hoverId === String(object.id)}
                                    onPointerDown={event => handleObjectPointerDown(event, object)}
                                    onPointerEnter={() => setHoverId(String(object.id))}
                                    onPointerLeave={() => setHoverId('')}
                                />
                            ))}
                            {selectionBox ? (
                                <Rect
                                    x={selectionBox.x * size.width}
                                    y={selectionBox.y * size.height}
                                    width={selectionBox.width * size.width}
                                    height={selectionBox.height * size.height}
                                    stroke="#0284C7"
                                    strokeWidth={2}
                                    dash={[8, 5]}
                                    fill="rgba(2, 132, 199, 0.06)"
                                    listening={false}
                                />
                            ) : null}
                            {state.marquee ? (
                                <Rect
                                    x={state.marquee.x * size.width}
                                    y={state.marquee.y * size.height}
                                    width={state.marquee.width * size.width}
                                    height={state.marquee.height * size.height}
                                    stroke="#0EA5E9"
                                    strokeWidth={1.5}
                                    dash={[6, 4]}
                                    fill="rgba(14, 165, 233, 0.1)"
                                    listening={false}
                                />
                            ) : null}
                        </Layer>
                    </Stage>
                )}
            </div>
            <div className="studio-konva-frame-row">
                {(frameData.frames || []).map(frame => (
                    <button
                        type="button"
                        key={frame.frameId}
                        className={String(frame.frameId) === String(activeFrame?.frameId) ? 'is-active' : ''}
                        onClick={() => setActiveFrameId(frame.frameId)}
                    >
                        <strong>{frame.label || frame.title || `\u9636\u6bb5 ${frame.index || ''}`}</strong>
                        <span>{Number(frame.objectCount || frame.objectIds?.length || 0)} {ui.objects}</span>
                    </button>
                ))}
            </div>
            <Inspector
                state={state}
                objectsById={objectsById}
                onCommand={state.setCommand}
                onChip={text => state.setCommand(text)}
                onApply={handleApply}
            />
        </div>
    );
}

function mount(rootElement, props = {}) {
    if (!rootElement) {
        return { update() {}, unmount() {} };
    }
    const root = createRoot(rootElement);
    let latestProps = { ...props };
    const render = () => root.render(<StudioCanvasApp {...latestProps} />);
    render();
    return {
        update(nextProps = {}) {
            latestProps = { ...latestProps, ...nextProps };
            render();
        },
        unmount() {
            root.unmount();
        },
    };
}

if (typeof window !== 'undefined') {
    window.ManimStudioCanvas = { mount };
}

export { mount };
