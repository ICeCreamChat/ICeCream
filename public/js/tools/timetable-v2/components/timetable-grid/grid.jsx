/**
 * timetable-v2 / components / timetable-grid / grid.jsx
 *
 * 课表网格（局部 React + react-konva）。设计决策 1：仅此处用 React-Konva，
 * 其余工作台为 vanilla ES Module，两者经 store 单向数据流解耦。
 *
 * ───────────────────────── 红线 ─────────────────────────
 * - 本组件只读 props 渲染：project（日历 / 名称字典）、solution（后端解）。
 * - 不修改任何数据、不向 store 写入、不在前端算冲突 / 候选位 / 未排原因。
 * - 冲突 / 未排标注一律来自外部 props（conflictCells / solution.hardConflicts /
 *   solution.unplaced / diagnostics），网格只负责把它们画出来。
 * - onCellClick(cell) 仅作为「事件回调出」，由 vanilla 手动调整页决定如何处理。
 */

import React, { useMemo } from 'react';
import { Stage, Layer, Rect, Text, Group } from 'react-konva';

// ───────── 视觉常量（纯样式，无业务含义） ─────────
const HEADER_H = 36;   // 顶部星期表头高
const HEADER_W = 64;   // 左侧节次表头宽
const CELL_W = 120;  // 单元格宽
const CELL_H = 56;   // 单元格高（单节）
const GAP = 2;    // 格间留白
const PAD = 8;    // 块内边距

const FALLBACK_COLOR = {
    headerBg: '#f1f5f9',
    headerText: '#475569',
    gridBg: '#ffffff',
    cellBorder: '#e2e8f0',
    block: '#dbeafe',
    blockBorder: '#93c5fd',
    blockText: '#1e3a8a',
    blockSub: '#3b62a3',
    conflict: '#fee2e2',
    conflictBorder: '#f87171',
    roomTag: '#7c3aed',
    emptyBg: '#ffffff',
};

function cssVar(name, fallback) {
    if (typeof document === 'undefined') return fallback;
    const host = document.querySelector('.ttv2-workbench') || document.documentElement;
    return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
}

function buildPalette() {
    return {
        headerBg: cssVar('--ttv2-surface-alt', FALLBACK_COLOR.headerBg),
        headerText: cssVar('--ttv2-text-muted', FALLBACK_COLOR.headerText),
        gridBg: cssVar('--ttv2-bg', FALLBACK_COLOR.gridBg),
        cellBorder: cssVar('--ttv2-border', FALLBACK_COLOR.cellBorder),
        block: cssVar('--ttv2-hover', FALLBACK_COLOR.block),
        blockBorder: cssVar('--ttv2-border-strong', FALLBACK_COLOR.blockBorder),
        blockText: cssVar('--ttv2-text', FALLBACK_COLOR.blockText),
        blockSub: cssVar('--ttv2-text-muted', FALLBACK_COLOR.blockSub),
        conflict: 'rgba(248, 113, 113, 0.18)',
        conflictBorder: cssVar('--ttv2-error', FALLBACK_COLOR.conflictBorder),
        roomTag: cssVar('--ttv2-draft-border', FALLBACK_COLOR.roomTag),
        emptyBg: 'rgba(255, 255, 255, 0.025)',
    };
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 把名称字典化，便于 O(1) 取 subject / teacher / class / room 显示名。
 */
function buildLookup(project) {
    const idx = (list) => {
        const m = new Map();
        for (const it of list || []) m.set(it.id, it.name || it.id);
        return m;
    };
    return {
        subject: idx(project && project.subjects),
        teacher: idx(project && project.teachers),
        klass: idx(project && project.classes),
        room: idx(project && project.rooms),
    };
}

/** 取每个 (day,period) 起始 placement；连堂只在起始格落一次。 */
function buildPlacementMap(placements) {
    const m = new Map();
    for (const p of placements || []) {
        m.set(`${p.day}:${p.period}`, p);
    }
    return m;
}

/** 冲突格集合（外部传入，网格不自行判定）。 */
function buildConflictSet(conflictCells) {
    const s = new Set();
    for (const c of conflictCells || []) {
        if (c && c.day != null && c.period != null) s.add(`${c.day}:${c.period}`);
    }
    return s;
}

/** 单个连堂 / 单节块。纯展示，点击仅回调。 */
function PlacementBlock({ x, y, w, h, placement, lookup, conflict, onCellClick, color }) {
    const subjectName = lookup.subject.get(placement.subjectId) || placement.subjectId || '';
    const teacherName = (placement.teacherIds || [])
        .map((t) => lookup.teacher.get(t) || t)
        .join('、');
    const roomName = placement.roomId ? (lookup.room.get(placement.roomId) || placement.roomId) : '';

    const cell = {
        day: placement.day,
        period: placement.period,
        placement,
    };

    return (
        <Group
            x={x}
            y={y}
            onClick={() => onCellClick && onCellClick(cell)}
            onTap={() => onCellClick && onCellClick(cell)}
        >
            <Rect
                width={w}
                height={h}
                cornerRadius={6}
                fill={conflict ? color.conflict : color.block}
                stroke={conflict ? color.conflictBorder : color.blockBorder}
                strokeWidth={1}
            />
            <Text
                x={PAD}
                y={PAD}
                width={w - PAD * 2}
                text={subjectName}
                fontSize={15}
                fontStyle="bold"
                fill={color.blockText}
                ellipsis
                wrap="none"
            />
            {teacherName ? (
                <Text
                    x={PAD}
                    y={PAD + 20}
                    width={w - PAD * 2}
                    text={teacherName}
                    fontSize={12}
                    fill={color.blockSub}
                    ellipsis
                    wrap="none"
                />
            ) : null}
            {roomName ? (
                <Text
                    x={PAD}
                    y={h - PAD - 12}
                    width={w - PAD * 2}
                    text={`@ ${roomName}`}
                    fontSize={11}
                    fill={color.roomTag}
                    ellipsis
                    wrap="none"
                />
            ) : null}
            {placement.duration > 1 ? (
                <Text
                    x={w - PAD - 28}
                    y={PAD}
                    text={`${placement.duration}连`}
                    fontSize={11}
                    fill={color.blockSub}
                />
            ) : null}
        </Group>
    );
}

/** 空格（可点，回调里 placement 为 null）。 */
function EmptyCell({ x, y, w, h, day, period, conflict, onCellClick, color }) {
    return (
        <Rect
            x={x}
            y={y}
            width={w}
            height={h}
            cornerRadius={6}
            fill={conflict ? color.conflict : color.emptyBg}
            stroke={conflict ? color.conflictBorder : color.cellBorder}
            strokeWidth={1}
            onClick={() => onCellClick && onCellClick({ day, period, placement: null })}
            onTap={() => onCellClick && onCellClick({ day, period, placement: null })}
        />
    );
}

/**
 * 课表网格组件。
 *
 * @param {object}   props
 * @param {object}   props.project        后端返回的 project 引用（日历 / 名称字典来源）
 * @param {object}   props.solution       后端返回的 solution 引用（placements 来源）
 * @param {Array}    [props.conflictCells] 外部传入的冲突格 [{day,period}]，网格只画不算
 * @param {Function} [props.onCellClick]   单元格点击回调 (cell) => void
 */
export default function TimetableGrid({ project, solution, conflictCells, onCellClick }) {
    const calendar = (project && project.calendar) || { weekdays: 5, periodsPerDay: 6 };
    const weekdays = Math.max(1, calendar.weekdays || 5);
    const periods = Math.max(1, calendar.periodsPerDay || 6);

    const lookup = useMemo(() => buildLookup(project), [project]);
    const placementMap = useMemo(
        () => buildPlacementMap(solution && solution.placements),
        [solution]
    );
    const conflictSet = useMemo(() => buildConflictSet(conflictCells), [conflictCells]);
    const color = buildPalette();

    // 标记被连堂块覆盖的「跟随格」，渲染时跳过（不再画空格）。
    const covered = useMemo(() => {
        const s = new Set();
        for (const p of (solution && solution.placements) || []) {
            const dur = p.duration > 1 ? p.duration : 1;
            for (let i = 1; i < dur; i++) {
                s.add(`${p.day}:${p.period + i}`);
            }
        }
        return s;
    }, [solution]);

    const stageW = HEADER_W + weekdays * (CELL_W + GAP) + GAP;
    const stageH = HEADER_H + periods * (CELL_H + GAP) + GAP;

    const colX = (day) => HEADER_W + (day - 1) * (CELL_W + GAP) + GAP;
    const rowY = (period) => HEADER_H + (period - 1) * (CELL_H + GAP) + GAP;

    // 表头单元
    const headerCells = [];
    for (let d = 1; d <= weekdays; d++) {
        headerCells.push(
            <Group key={`hd-${d}`}>
                <Rect
                    x={colX(d)}
                    y={0}
                    width={CELL_W}
                    height={HEADER_H}
                    fill={color.headerBg}
                />
                <Text
                    x={colX(d)}
                    y={0}
                    width={CELL_W}
                    height={HEADER_H}
                    text={WEEKDAY_LABELS[d - 1] || `第${d}天`}
                    fontSize={14}
                    fontStyle="bold"
                    fill={color.headerText}
                    align="center"
                    verticalAlign="middle"
                />
            </Group>
        );
    }
    for (let pr = 1; pr <= periods; pr++) {
        headerCells.push(
            <Group key={`hp-${pr}`}>
                <Rect
                    x={0}
                    y={rowY(pr)}
                    width={HEADER_W}
                    height={CELL_H}
                    fill={color.headerBg}
                />
                <Text
                    x={0}
                    y={rowY(pr)}
                    width={HEADER_W}
                    height={CELL_H}
                    text={`第${pr}节`}
                    fontSize={13}
                    fill={color.headerText}
                    align="center"
                    verticalAlign="middle"
                />
            </Group>
        );
    }

    // 主体单元
    const bodyCells = [];
    for (let d = 1; d <= weekdays; d++) {
        for (let pr = 1; pr <= periods; pr++) {
            const key = `${d}:${pr}`;
            if (covered.has(key)) continue; // 被上方连堂块覆盖

            const x = colX(d);
            const y = rowY(pr);
            const conflict = conflictSet.has(key);
            const placement = placementMap.get(key);

            if (placement) {
                const dur = placement.duration > 1 ? placement.duration : 1;
                const h = dur * CELL_H + (dur - 1) * GAP;
                bodyCells.push(
                    <PlacementBlock
                        key={`b-${key}`}
                        x={x}
                        y={y}
                        w={CELL_W}
                        h={h}
                        placement={placement}
                        lookup={lookup}
                        conflict={conflict}
                        onCellClick={onCellClick}
                        color={color}
                    />
                );
            } else {
                bodyCells.push(
                    <EmptyCell
                        key={`e-${key}`}
                        x={x}
                        y={y}
                        w={CELL_W}
                        h={CELL_H}
                        day={d}
                        period={pr}
                        conflict={conflict}
                        onCellClick={onCellClick}
                        color={color}
                    />
                );
            }
        }
    }

    return (
        <Stage width={stageW} height={stageH}>
            <Layer>
                <Rect x={0} y={0} width={stageW} height={stageH} fill={color.gridBg} />
                {headerCells}
                {bodyCells}
            </Layer>
        </Stage>
    );
}
