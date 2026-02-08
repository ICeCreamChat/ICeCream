/**
 * ICeCream - ContentDetector Module
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Smart content type detection for adaptive question board rendering.
 * Detects: tables, images, formulas, and plain text.
 */
const ContentDetector = {
    // Content type constants
    TYPES: {
        TEXT: 'text',
        TABLE: 'table',
        IMAGE: 'image',
        FORMULA: 'formula',
        MIXED: 'mixed'
    },

    // Detection patterns
    patterns: {
        // Table detection patterns
        table: {
            markdown: /\|[\s\S]*?\|[\s\S]*?\|/m,
            html: /<table[\s\S]*?<\/table>/i,
            pipe: /^\s*\|.*\|.*\|/m,
            separator: /\|[\s-:]+\|/
        },
        // Image detection patterns
        image: {
            markdown: /!\[.*?\]\(.*?\)/,
            html: /<img[^>]+>/i,
            dataUrl: /data:image\/[^;]+;base64,/i,
            url: /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)/i
        },
        // Formula detection patterns (LaTeX)
        formula: {
            blockDisplay: /\$\$[\s\S]+?\$\$/,
            inline: /\$[^$\n]+\$/,
            latexFrac: /\\frac\s*\{/,
            latexEnv: /\\begin\{(equation|align|matrix|pmatrix|bmatrix|cases)\}/,
            latexBracket: /\\\[[\s\S]+?\\\]/,
            latexParen: /\\\([\s\S]+?\\\)/,
            latexSymbols: /\\(sum|int|prod|sqrt|alpha|beta|gamma|delta|theta|pi|sigma|omega|infty|partial|nabla|times|cdot|pm|mp|leq|geq|neq|approx|equiv)/
        }
    },

    /**
     * Analyzes content and returns detailed type information.
     * @param {string} content - Raw text content to analyze
     * @returns {Object} Analysis result with type, blocks, and metadata
     */
    analyze(content) {
        if (!content || typeof content !== 'string') {
            return this._createResult(this.TYPES.TEXT, [], { isEmpty: true });
        }

        const trimmedContent = content.trim();
        if (!trimmedContent) {
            return this._createResult(this.TYPES.TEXT, [], { isEmpty: true });
        }

        // Detect all content types present
        const detections = {
            hasTable: this._detectTable(trimmedContent),
            hasImage: this._detectImage(trimmedContent),
            hasFormula: this._detectFormula(trimmedContent)
        };

        // Parse content into blocks
        const blocks = this._parseBlocks(trimmedContent, detections);

        // Determine primary type
        const type = this._determinePrimaryType(detections, blocks);

        // Calculate metadata
        const metadata = this._calculateMetadata(trimmedContent, detections, blocks);

        return this._createResult(type, blocks, metadata);
    },

    /**
     * Detects if content contains table structures.
     * @private
     */
    _detectTable(content) {
        const { table } = this.patterns;
        return (
            table.markdown.test(content) ||
            table.html.test(content) ||
            (table.pipe.test(content) && table.separator.test(content))
        );
    },

    /**
     * Detects if content contains images.
     * @private
     */
    _detectImage(content) {
        const { image } = this.patterns;
        return (
            image.markdown.test(content) ||
            image.html.test(content) ||
            image.dataUrl.test(content) ||
            image.url.test(content)
        );
    },

    /**
     * Detects if content contains LaTeX formulas.
     * @private
     */
    _detectFormula(content) {
        const { formula } = this.patterns;
        return (
            formula.blockDisplay.test(content) ||
            formula.inline.test(content) ||
            formula.latexFrac.test(content) ||
            formula.latexEnv.test(content) ||
            formula.latexBracket.test(content) ||
            formula.latexParen.test(content) ||
            formula.latexSymbols.test(content)
        );
    },

    /**
     * Parses content into typed blocks for rendering.
     * @private
     */
    _parseBlocks(content, detections) {
        const blocks = [];
        let remainingContent = content;
        let order = 0;

        // Extract tables first (they're most structurally significant)
        if (detections.hasTable) {
            const tableMatches = this._extractTables(remainingContent);
            tableMatches.forEach(match => {
                blocks.push({
                    type: this.TYPES.TABLE,
                    content: match.content,
                    raw: match.raw,
                    order: order++,
                    position: match.position
                });
            });
        }

        // Extract images
        if (detections.hasImage) {
            const imageMatches = this._extractImages(remainingContent);
            imageMatches.forEach(match => {
                blocks.push({
                    type: this.TYPES.IMAGE,
                    content: match.content,
                    alt: match.alt || '',
                    order: order++,
                    position: match.position
                });
            });
        }

        // Extract block formulas ($$...$$)
        if (detections.hasFormula) {
            const formulaMatches = this._extractBlockFormulas(remainingContent);
            formulaMatches.forEach(match => {
                blocks.push({
                    type: this.TYPES.FORMULA,
                    content: match.content,
                    isBlock: true,
                    order: order++,
                    position: match.position
                });
            });
        }

        // Sort blocks by position
        blocks.sort((a, b) => (a.position || 0) - (b.position || 0));

        // Re-assign order after sorting
        blocks.forEach((block, idx) => block.order = idx);

        // If no special blocks found, treat entire content as text
        if (blocks.length === 0) {
            blocks.push({
                type: this.TYPES.TEXT,
                content: content,
                order: 0
            });
        }

        return blocks;
    },

    /**
     * Extracts table content from text.
     * @private
     */
    _extractTables(content) {
        const tables = [];
        
        // Match HTML tables
        const htmlTableRegex = /<table[\s\S]*?<\/table>/gi;
        let match;
        while ((match = htmlTableRegex.exec(content)) !== null) {
            tables.push({
                content: match[0],
                raw: match[0],
                position: match.index
            });
        }

        // Match Markdown tables (simplified)
        const lines = content.split('\n');
        let tableStart = -1;
        let tableLines = [];
        
        lines.forEach((line, idx) => {
            const isTableLine = /^\s*\|.*\|/.test(line);
            if (isTableLine) {
                if (tableStart === -1) tableStart = idx;
                tableLines.push(line);
            } else if (tableStart !== -1) {
                // End of table
                if (tableLines.length >= 2) {
                    tables.push({
                        content: tableLines.join('\n'),
                        raw: tableLines.join('\n'),
                        position: content.indexOf(tableLines[0])
                    });
                }
                tableStart = -1;
                tableLines = [];
            }
        });

        // Handle table at end of content
        if (tableLines.length >= 2) {
            tables.push({
                content: tableLines.join('\n'),
                raw: tableLines.join('\n'),
                position: content.indexOf(tableLines[0])
            });
        }

        return tables;
    },

    /**
     * Extracts image references from text.
     * @private
     */
    _extractImages(content) {
        const images = [];

        // Match Markdown images ![alt](url)
        const mdImageRegex = /!\[(.*?)\]\((.*?)\)/g;
        let match;
        while ((match = mdImageRegex.exec(content)) !== null) {
            images.push({
                content: match[2],
                alt: match[1],
                position: match.index
            });
        }

        // Match HTML images
        const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
        while ((match = htmlImageRegex.exec(content)) !== null) {
            const altMatch = match[0].match(/alt=["']([^"']*)["']/i);
            images.push({
                content: match[1],
                alt: altMatch ? altMatch[1] : '',
                position: match.index
            });
        }

        return images;
    },

    /**
     * Extracts block-level formulas from text.
     * @private
     */
    _extractBlockFormulas(content) {
        const formulas = [];

        // Match $$...$$ block formulas
        const blockFormulaRegex = /\$\$([\s\S]+?)\$\$/g;
        let match;
        while ((match = blockFormulaRegex.exec(content)) !== null) {
            formulas.push({
                content: match[1].trim(),
                position: match.index
            });
        }

        // Match \[...\] formulas
        const bracketFormulaRegex = /\\\[([\s\S]+?)\\\]/g;
        while ((match = bracketFormulaRegex.exec(content)) !== null) {
            formulas.push({
                content: match[1].trim(),
                position: match.index
            });
        }

        return formulas;
    },

    /**
     * Determines the primary content type.
     * @private
     */
    _determinePrimaryType(detections, blocks) {
        const typeCount = [
            detections.hasTable,
            detections.hasImage,
            detections.hasFormula
        ].filter(Boolean).length;

        // Multiple types = mixed
        if (typeCount >= 2) {
            return this.TYPES.MIXED;
        }

        // Single dominant type
        if (detections.hasTable) return this.TYPES.TABLE;
        if (detections.hasImage) return this.TYPES.IMAGE;
        if (detections.hasFormula) return this.TYPES.FORMULA;

        return this.TYPES.TEXT;
    },

    /**
     * Calculates metadata for layout decisions.
     * @private
     */
    _calculateMetadata(content, detections, blocks) {
        // Estimate reading time (avg 200 words/min for Chinese)
        const charCount = content.length;
        const estimatedReadTime = Math.ceil(charCount / 400); // minutes

        // Calculate complexity score (1-5)
        let complexity = 1;
        if (detections.hasFormula) complexity += 1;
        if (detections.hasTable) complexity += 1;
        if (detections.hasImage) complexity += 1;
        if (blocks.length > 3) complexity += 1;
        complexity = Math.min(complexity, 5);

        // Determine suggested card size
        const cardSize = this._suggestCardSize(detections, blocks);

        return {
            hasTable: detections.hasTable,
            hasImage: detections.hasImage,
            hasFormula: detections.hasFormula,
            blockCount: blocks.length,
            charCount,
            estimatedReadTime,
            complexity,
            cardSize,
            isEmpty: false
        };
    },

    /**
     * Suggests optimal card size based on content.
     * @private
     */
    _suggestCardSize(detections, blocks) {
        // Tables need horizontal space
        if (detections.hasTable) {
            return detections.hasImage ? '2x2' : '2x1';
        }

        // Images need vertical space
        if (detections.hasImage) {
            return blocks.length > 2 ? '2x2' : '1x2';
        }

        // Formula-heavy content
        if (detections.hasFormula && blocks.length > 2) {
            return '1x2';
        }

        // Default text
        return '1x1';
    },

    /**
     * Creates a standardized result object.
     * @private
     */
    _createResult(type, blocks, metadata) {
        return {
            type,
            blocks,
            metadata: {
                ...metadata,
                typeLabel: this._getTypeLabel(type),
                typeIcon: this._getTypeIcon(type)
            }
        };
    },

    /**
     * Gets human-readable label for content type.
     * @private
     */
    _getTypeLabel(type) {
        const labels = {
            [this.TYPES.TEXT]: '纯文本',
            [this.TYPES.TABLE]: '含表格',
            [this.TYPES.IMAGE]: '含图片',
            [this.TYPES.FORMULA]: '含公式',
            [this.TYPES.MIXED]: '复合内容'
        };
        return labels[type] || '未知';
    },

    /**
     * Gets icon name for content type.
     * @private
     */
    _getTypeIcon(type) {
        const icons = {
            [this.TYPES.TEXT]: 'file-text',
            [this.TYPES.TABLE]: 'table-2',
            [this.TYPES.IMAGE]: 'image',
            [this.TYPES.FORMULA]: 'function-square',
            [this.TYPES.MIXED]: 'layers'
        };
        return icons[type] || 'file';
    },

    /**
     * Quick check if content has any special types.
     * @param {string} content - Content to check
     * @returns {boolean} True if content has tables, images, or formulas
     */
    hasSpecialContent(content) {
        if (!content) return false;
        return (
            this._detectTable(content) ||
            this._detectImage(content) ||
            this._detectFormula(content)
        );
    }
};

// Expose to window for global access
window.ContentDetector = ContentDetector;
