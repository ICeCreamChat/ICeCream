import {
    buildTextHash,
    normalizeSourceDisplayText,
    normalizeSourceText,
} from './source-identity.js';

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
}

function uniqueStrings(values = []) {
    return [...new Set(asArray(values).map(value => String(value ?? '').trim()).filter(Boolean))];
}

function artifactText(artifact = {}) {
    const candidates = [
        artifact.rawText,
        artifact.constraintText,
        artifact.text,
        artifact.source?.rawText,
        artifact.evidence?.quote,
        artifact.evidence?.text,
        typeof artifact.evidence === 'object' ? '' : artifact.evidence,
        artifact.description,
        artifact.reason,
        artifact.reviewEvidence?.quote,
    ];
    for (const candidate of candidates) {
        const normalized = normalizeSourceDisplayText(candidate);
        if (normalized) return normalized;
    }
    return '';
}

function explicitTextHash(artifact = {}) {
    return normalizeSourceText(artifact.textHash || artifact.source?.textHash || artifact.target?.textHash || artifact.evidence?.textHash || '');
}

function sourceIdOf(artifact = {}) {
    return normalizeSourceText(artifact.sourceId || artifact.source?.sourceId || artifact.target?.sourceId || artifact.evidence?.sourceId || '');
}

function sourceLocation(artifact = {}) {
    const sourceSheet = normalizeSourceText(
        artifact.sourceSheet
        || artifact.sheetName
        || artifact.source?.sourceSheet
        || artifact.source?.sheetName
        || artifact.target?.sourceSheet
        || artifact.evidence?.sourceSheet
        || ''
    );
    const sourceRow = Number(
        artifact.sourceRow
        ?? artifact.rowNumber
        ?? artifact.source?.sourceRow
        ?? artifact.source?.rowNumber
        ?? artifact.target?.sourceRow
        ?? artifact.evidence?.sourceRow
    );
    const lineNumber = Number(artifact.lineNumber ?? artifact.source?.lineNumber ?? artifact.target?.lineNumber ?? artifact.evidence?.lineNumber);
    return {
        sourceSheet,
        sourceRow: Number.isInteger(sourceRow) && sourceRow > 0 ? sourceRow : null,
        lineNumber: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null,
    };
}

function evidenceHashOf(artifact = {}, allowLegacyEvidence = true) {
    const explicit = explicitTextHash(artifact);
    if (explicit) return { textHash: explicit, explicit: true };
    const rawText = artifactText(artifact);
    if (!allowLegacyEvidence || !rawText) return { textHash: '', explicit: false };
    return { textHash: buildTextHash(rawText), explicit: false };
}

function reasonCode(reason = '') {
    return `ai_source_${reason || 'missing_source_identity'}`;
}

const REASON_MESSAGES = {
    unknown_source_id: 'AI 返回了不存在的 sourceId，该结果已拒绝。',
    text_hash_mismatch: 'AI 返回的 textHash 与原始输入不一致，该结果已拒绝。',
    ambiguous_source_position: 'AI 返回的来源位置对应多条输入，无法唯一关联，该结果已拒绝。',
    ambiguous_text_hash: 'AI 返回的文本哈希对应多条重复原文，无法唯一关联，该结果已拒绝。',
    missing_text_hash: 'AI 结果缺少可验证的 textHash 或原文证据，该结果已拒绝。',
    missing_source_identity: 'AI 结果缺少可唯一验证的来源身份，该结果已拒绝。',
};

function warningForArtifact(artifact = {}, reason = '', index = 0, artifactKind = 'artifact', parsedBy = 'ai') {
    const message = REASON_MESSAGES[reason] || REASON_MESSAGES.missing_source_identity;
    const location = sourceLocation(artifact);
    const warning = {
        code: reasonCode(reason),
        message,
        severity: 'warning',
        artifactKind,
        artifactIndex: index,
        sourceId: sourceIdOf(artifact),
        textHash: explicitTextHash(artifact),
        origin: artifact.origin || '',
        parsedBy: uniqueStrings([...asArray(artifact.parsedBy), ...asArray(parsedBy)]),
        sourceSheet: location.sourceSheet,
        sourceRow: location.sourceRow,
        lineNumber: location.lineNumber,
        rawText: artifactText(artifact),
        warnings: [message],
    };
    return warning;
}

function validateHash(source, requestedHash = '') {
    if (!requestedHash) return { source: null, reason: 'missing_text_hash' };
    if (source.source.textHash !== requestedHash) return { source: null, reason: 'text_hash_mismatch' };
    return { source, reason: '' };
}

export function findAiArtifactSource(artifact = {}, sourceRequirements = [], options = {}) {
    const sources = asArray(sourceRequirements);
    const allowLegacyEvidence = options.allowLegacyEvidence !== false;
    const requestedId = sourceIdOf(artifact);
    const { textHash: requestedHash } = evidenceHashOf(artifact, allowLegacyEvidence);
    const location = sourceLocation(artifact);

    if (requestedId) {
        const source = sources.find(item => item.sourceId === requestedId);
        if (!source) return { source: null, reason: 'unknown_source_id' };
        return validateHash(source, requestedHash);
    }

    if (location.sourceRow) {
        const positional = sources.filter(item => item.source.rowNumber === location.sourceRow
            && (!location.sourceSheet || item.source.sheetName === location.sourceSheet));
        if (positional.length === 1) return validateHash(positional[0], requestedHash);
        if (positional.length > 1) return { source: null, reason: 'ambiguous_source_position' };
    }

    if (location.lineNumber) {
        const positional = sources.filter(item => item.source.lineNumber === location.lineNumber);
        if (positional.length === 1) return validateHash(positional[0], requestedHash);
        if (positional.length > 1) return { source: null, reason: 'ambiguous_source_position' };
    }

    if (requestedHash) {
        const matches = sources.filter(item => item.source.textHash === requestedHash);
        if (matches.length === 1) return { source: matches[0], reason: '' };
        if (matches.length > 1) return { source: null, reason: 'ambiguous_text_hash' };
        return { source: null, reason: 'text_hash_mismatch' };
    }

    return { source: null, reason: 'missing_source_identity' };
}

function attachSourceIdentity(artifact = {}, source = {}, parsedBy = 'ai') {
    return {
        ...artifact,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        origin: source.origin,
        parsedBy: uniqueStrings([
            ...asArray(source.parsedBy),
            ...asArray(artifact.parsedBy),
            ...asArray(parsedBy),
        ]),
        sourceSheet: source.source.sheetName || undefined,
        sourceRow: source.source.rowNumber || undefined,
        lineNumber: source.source.lineNumber || undefined,
        rawText: source.source.rawText,
    };
}

export function alignAiArtifactsToSources(artifacts = [], sourceRequirements = [], options = {}) {
    const artifactKind = options.artifactKind || 'artifact';
    const parsedBy = options.parsedBy || 'ai';
    const aligned = [];
    const rejected = [];
    const warnings = [];

    asArray(artifacts).forEach((artifact, index) => {
        if (!artifact || typeof artifact !== 'object') {
            const rejectedArtifact = { value: artifact };
            rejected.push({ artifact: rejectedArtifact, reason: 'missing_source_identity', index });
            warnings.push(warningForArtifact(rejectedArtifact, 'missing_source_identity', index, artifactKind, parsedBy));
            return;
        }
        const match = findAiArtifactSource(artifact, sourceRequirements, options);
        if (!match.source) {
            rejected.push({ artifact: { ...artifact }, reason: match.reason, index });
            warnings.push(warningForArtifact(artifact, match.reason, index, artifactKind, parsedBy));
            return;
        }
        aligned.push(attachSourceIdentity(artifact, match.source, parsedBy));
    });

    return { artifacts: aligned, rejected, warnings };
}

export function sourceRequirementsToAiInputs(sourceRequirements = []) {
    return asArray(sourceRequirements).map(source => ({
        sourceId: source.sourceId,
        textHash: source.source?.textHash || source.textHash || '',
        rawText: source.source?.rawText || source.rawText || '',
        sourceSheet: source.source?.sheetName || source.sourceSheet || '',
        sourceRow: source.source?.rowNumber || source.sourceRow || null,
        lineNumber: source.source?.lineNumber || source.lineNumber || null,
    }));
}
