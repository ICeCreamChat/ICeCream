import { readFileSync } from 'node:fs';

const COMMAND_INDEX_URL = new URL('./commands-index.json', import.meta.url);
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const CURATED_COMMAND_INDEX = {
    circle: {
        commandBase: 'Circle',
        overloads: [
            {
                signature: 'Circle( <Point>, <Number> )',
                paramCount: 2,
                paramTypes: ['Point', 'Number'],
                description: 'Creates a circle with given center and radius.',
                examples: [{ description: 'Circle centered at A with radius 2', command: 'Circle(A, 2)' }],
                note: '',
            },
            {
                signature: 'Circle( <Point>, <Point> )',
                paramCount: 2,
                paramTypes: ['Point', 'Point'],
                description: 'Creates a circle with center through another point.',
                examples: [{ description: 'Circle centered at A through B', command: 'Circle(A, B)' }],
                note: '',
            },
            {
                signature: 'Circle( <Point>, <Point>, <Point> )',
                paramCount: 3,
                paramTypes: ['Point', 'Point', 'Point'],
                description: 'Creates a circle through three points.',
                examples: [{ description: 'Circumcircle through A, B and C', command: 'Circle(A, B, C)' }],
                note: '',
            },
        ],
    },
    point: {
        commandBase: 'Point',
        overloads: [
            {
                signature: 'Point( <Object> )',
                paramCount: 1,
                paramTypes: ['Object'],
                description: 'Creates a point on the given object.',
                examples: [{ description: 'Point on line f', command: 'Point(f)' }],
                note: '',
            },
        ],
    },
    line: {
        commandBase: 'Line',
        overloads: [
            {
                signature: 'Line( <Point>, <Point> )',
                paramCount: 2,
                paramTypes: ['Point', 'Point'],
                description: 'Creates a line through two points.',
                examples: [{ description: 'Line through A and B', command: 'Line(A, B)' }],
                note: '',
            },
        ],
    },
    segment: {
        commandBase: 'Segment',
        overloads: [
            {
                signature: 'Segment( <Point>, <Point> )',
                paramCount: 2,
                paramTypes: ['Point', 'Point'],
                description: 'Creates a segment between two points.',
                examples: [{ description: 'Segment AB', command: 'Segment(A, B)' }],
                note: '',
            },
        ],
    },
    polygon: {
        commandBase: 'Polygon',
        overloads: [
            {
                signature: 'Polygon( <Point>, ..., <Point> )',
                paramCount: 3,
                paramTypes: ['Point', 'Point', 'Point'],
                description: 'Creates a polygon from points.',
                examples: [{ description: 'Triangle ABC', command: 'Polygon(A, B, C)' }],
                note: '',
            },
        ],
    },
    intersect: {
        commandBase: 'Intersect',
        overloads: [
            {
                signature: 'Intersect( <Object>, <Object> )',
                paramCount: 2,
                paramTypes: ['Object', 'Object'],
                description: 'Creates intersection points of two objects.',
                examples: [{ description: 'Intersection of lines f and g', command: 'Intersect(f, g)' }],
                note: '',
            },
        ],
    },
    midpoint: {
        commandBase: 'Midpoint',
        overloads: [
            {
                signature: 'Midpoint( <Point>, <Point> )',
                paramCount: 2,
                paramTypes: ['Point', 'Point'],
                description: 'Creates the midpoint of two points.',
                examples: [{ description: 'Midpoint of A and B', command: 'Midpoint(A, B)' }],
                note: '',
            },
        ],
    },
    perpendicularline: {
        commandBase: 'PerpendicularLine',
        overloads: [
            {
                signature: 'PerpendicularLine( <Point>, <Line> )',
                paramCount: 2,
                paramTypes: ['Point', 'Line'],
                description: 'Creates a line through a point perpendicular to a line.',
                examples: [{ description: 'Line through A perpendicular to f', command: 'PerpendicularLine(A, f)' }],
                note: '',
            },
        ],
    },
    slider: {
        commandBase: 'Slider',
        overloads: [
            {
                signature: 'Slider( <Min>, <Max>, <Increment> )',
                paramCount: 3,
                paramTypes: ['Number', 'Number', 'Number'],
                description: 'Creates a numeric slider.',
                examples: [{ description: 'Slider from 0 to 10', command: 'Slider(0, 10, 1)' }],
                note: '',
            },
        ],
    },
};

const commandIndex = loadCommandIndex();
const commandEntries = Object.entries(commandIndex).map(([key, entry]) => ({
    key,
    commandBase: entry.commandBase,
    overloads: Array.isArray(entry.overloads) ? entry.overloads : [],
}));
const commandKeysByCharacter = buildCharacterIndex(commandEntries);

function loadCommandIndex() {
    const rawText = readFileSync(COMMAND_INDEX_URL, 'utf8');
    return {
        ...JSON.parse(rawText),
        ...CURATED_COMMAND_INDEX,
    };
}

function buildCharacterIndex(entries) {
    const characterIndex = new Map();

    for (const entry of entries) {
        for (const character of entry.key.toLowerCase()) {
            if (!characterIndex.has(character)) {
                characterIndex.set(character, new Set());
            }
            characterIndex.get(character).add(entry.key);
        }
    }

    return characterIndex;
}

export function normalizeSearchLimit(limitValue) {
    const parsedLimit = Number.parseInt(limitValue, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        return DEFAULT_LIMIT;
    }
    return Math.min(parsedLimit, MAX_LIMIT);
}

function getCandidateKeys(token) {
    const candidateKeys = new Set();
    for (const character of token) {
        const keysForCharacter = commandKeysByCharacter.get(character);
        if (keysForCharacter) {
            keysForCharacter.forEach(key => candidateKeys.add(key));
        }
    }
    return candidateKeys;
}

function scoreToken(commandKey, token) {
    if (!token) return 0;
    if (commandKey === token) return 1000;
    if (commandKey.startsWith(token)) return 700;
    if (commandKey.includes(token)) return 420;

    let score = 0;
    let tokenOffset = 0;
    for (let commandOffset = 0; commandOffset < commandKey.length && tokenOffset < token.length; commandOffset += 1) {
        if (commandKey[commandOffset] === token[tokenOffset]) {
            score += commandOffset === tokenOffset ? 12 : 7;
            tokenOffset += 1;
        }
    }
    return tokenOffset === token.length ? score + 80 : score;
}

function scoreCommandKey(commandKey, tokens) {
    return tokens.reduce((score, token) => score + scoreToken(commandKey, token), 0);
}

function normalizeQuery(query) {
    return String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean);
}

export function getGeoGebraCommandIndexStatus() {
    return {
        ready: commandEntries.length > 0,
        commandCount: commandEntries.length,
    };
}

export function searchGeoGebraCommands(query, limitValue = DEFAULT_LIMIT) {
    const tokens = normalizeQuery(query);
    if (tokens.length === 0) return [];

    const limit = normalizeSearchLimit(limitValue);
    const candidateKeys = new Set();
    tokens.forEach(token => getCandidateKeys(token).forEach(key => candidateKeys.add(key)));

    const scoredMatches = Array.from(candidateKeys)
        .map(key => {
            const entry = commandIndex[key];
            return {
                commandBase: entry.commandBase,
                overloads: entry.overloads || [],
                score: scoreCommandKey(key, tokens),
            };
        })
        .filter(match => match.score > 0)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return left.commandBase.localeCompare(right.commandBase);
        });

    return scoredMatches.slice(0, limit).map(({ commandBase, overloads }) => ({
        commandBase,
        overloads,
    }));
}
