/**
 * ICeCream - SmartRenderer Module
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Adaptive content rendering based on ContentDetector analysis.
 * Provides specialized renderers for tables, images, formulas, and text.
 */
const SmartRenderer = {
    /**
     * Renders content with smart type detection and adaptive layout.
     * @param {string} content - Raw content to render
     * @param {HTMLElement} container - Target container element
     * @param {Object} options - Rendering options
     */
    render(content, container, options = {}) {
        if (!container) {
            console.error('SmartRenderer: No container provided');
            return;
        }

        // Normalize content - fix table formatting issues
        const normalizedContent = this._normalizeContent(content);

        // Analyze content type
        const analysis = window.ContentDetector
            ? window.ContentDetector.analyze(normalizedContent)
            : { type: 'text', blocks: [{ type: 'text', content: normalizedContent }], metadata: {} };

        // Clear container and apply smart layout class
        container.innerHTML = '';
        container.className = container.className.replace(/smart-layout-\S+/g, '').trim();
        container.classList.add('smart-layout');
        container.classList.add(`smart-layout-${analysis.type}`);

        // Create content wrapper
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'smart-content-wrapper';

        // Render based on primary type
        switch (analysis.type) {
            case 'table':
                this._renderTableContent(normalizedContent, contentWrapper, analysis);
                break;
            case 'image':
                this._renderImageContent(normalizedContent, contentWrapper, analysis);
                break;
            case 'formula':
                this._renderFormulaContent(normalizedContent, contentWrapper, analysis);
                break;
            case 'mixed':
                this._renderMixedContent(normalizedContent, contentWrapper, analysis);
                break;
            default:
                this._renderTextContent(normalizedContent, contentWrapper, analysis);
        }

        container.appendChild(contentWrapper);

        // Apply preview mode if specified
        if (options.previewMode) {
            container.classList.add(`preview-${options.previewMode}`);
        }

        // Apply card size hint via data attribute
        container.dataset.cardSize = analysis.metadata.cardSize || '1x1';
        container.dataset.contentType = analysis.type;

        // Post-render: Initialize KaTeX if available
        this._postRender(container);

        return analysis;
    },

    /**
     * Creates content type indicator badge.
     * @private
     */
    _createTypeIndicator(analysis) {
        const indicator = document.createElement('div');
        indicator.className = 'smart-type-indicator';
        indicator.innerHTML = `
            <i data-lucide="${analysis.metadata.typeIcon}"></i>
            <span>${analysis.metadata.typeLabel}</span>
        `;

        // Initialize lucide icons
        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons({ nodes: [indicator] }), 0);
        }

        return indicator;
    },

    /**
     * Renders table-focused content.
     * @private
     */
    _renderTableContent(content, container, analysis) {
        // Split content by table blocks
        const wrapper = document.createElement('div');
        wrapper.className = 'smart-table-layout';

        // Render any text before/after tables with MathRenderer
        const textContainer = document.createElement('div');
        textContainer.className = 'smart-text-section';

        if (window.MathRenderer) {
            window.MathRenderer.renderMarkdown(content, textContainer);
        } else {
            textContainer.innerHTML = this._simpleMarkdown(content);
        }

        // Wrap tables with scrollable container
        const tables = textContainer.querySelectorAll('table');
        tables.forEach(table => {
            const tableWrapper = document.createElement('div');
            tableWrapper.className = 'smart-table-wrapper';

            // Add zebra striping
            this._enhanceTable(table);

            // Create scroll hint
            const scrollHint = document.createElement('div');
            scrollHint.className = 'smart-table-scroll-hint';
            scrollHint.innerHTML = '<span>← 横向滚动查看更多 →</span>';

            table.parentNode.insertBefore(tableWrapper, table);
            tableWrapper.appendChild(table);
            tableWrapper.appendChild(scrollHint);
        });

        wrapper.appendChild(textContainer);
        container.appendChild(wrapper);
    },

    /**
     * Enhances table with better styling.
     * @private
     */
    _enhanceTable(table) {
        table.classList.add('smart-table');

        // Add zebra striping to tbody rows
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach((row, idx) => {
            if (idx % 2 === 1) {
                row.classList.add('smart-table-row-alt');
            }
        });

        // Mark header row
        const headerRow = table.querySelector('thead tr');
        if (headerRow) {
            headerRow.classList.add('smart-table-header');
        }
    },

    /**
     * Renders image-focused content.
     * @private
     */
    _renderImageContent(content, container, analysis) {
        const wrapper = document.createElement('div');
        wrapper.className = 'smart-image-layout';

        // Render with MathRenderer first
        const textContainer = document.createElement('div');
        textContainer.className = 'smart-text-section';

        if (window.MathRenderer) {
            window.MathRenderer.renderMarkdown(content, textContainer);
        } else {
            textContainer.innerHTML = this._simpleMarkdown(content);
        }

        // Enhance images
        const images = textContainer.querySelectorAll('img');
        images.forEach(img => {
            const imageWrapper = document.createElement('div');
            imageWrapper.className = 'smart-image-wrapper';

            // Add loading placeholder
            img.classList.add('smart-image');
            img.setAttribute('loading', 'lazy');

            // Add click to zoom
            img.addEventListener('click', () => {
                if (window.openImageLightbox) {
                    window.openImageLightbox(img.src);
                }
            });

            // Add caption if alt text exists
            if (img.alt) {
                const caption = document.createElement('div');
                caption.className = 'smart-image-caption';
                caption.textContent = img.alt;
                img.parentNode.insertBefore(imageWrapper, img);
                imageWrapper.appendChild(img);
                imageWrapper.appendChild(caption);
            } else {
                img.parentNode.insertBefore(imageWrapper, img);
                imageWrapper.appendChild(img);
            }

            // Add zoom button
            const zoomBtn = document.createElement('button');
            zoomBtn.className = 'smart-image-zoom-btn';
            zoomBtn.innerHTML = '<i data-lucide="zoom-in"></i>';
            zoomBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.openImageLightbox) {
                    window.openImageLightbox(img.src);
                }
            });
            imageWrapper.appendChild(zoomBtn);
        });

        wrapper.appendChild(textContainer);
        container.appendChild(wrapper);

        // Refresh lucide icons
        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons({ nodes: [wrapper] }), 0);
        }
    },

    /**
     * Renders formula-focused content.
     * @private
     */
    _renderFormulaContent(content, container, analysis) {
        const wrapper = document.createElement('div');
        wrapper.className = 'smart-formula-layout';

        // Create text container
        const textContainer = document.createElement('div');
        textContainer.className = 'smart-text-section';

        // Use MathRenderer for full LaTeX support
        if (window.MathRenderer) {
            window.MathRenderer.renderMarkdown(content, textContainer);
        } else {
            textContainer.innerHTML = this._simpleMarkdown(content);
        }

        // Enhance block formulas with special styling
        const katexBlocks = textContainer.querySelectorAll('.katex-display');
        katexBlocks.forEach(block => {
            const formulaWrapper = document.createElement('div');
            formulaWrapper.className = 'smart-formula-block';

            // Add copy button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'smart-formula-copy-btn';
            copyBtn.innerHTML = '<i data-lucide="copy"></i>';
            copyBtn.title = '复制公式';
            copyBtn.addEventListener('click', () => {
                // Try to get the original LaTeX source
                const annotation = block.querySelector('annotation[encoding="application/x-tex"]');
                const latex = annotation ? annotation.textContent : block.textContent;
                navigator.clipboard.writeText(latex).then(() => {
                    if (window.showToast) {
                        window.showToast('已复制公式', 'success');
                    }
                });
            });

            block.parentNode.insertBefore(formulaWrapper, block);
            formulaWrapper.appendChild(block);
            formulaWrapper.appendChild(copyBtn);
        });

        wrapper.appendChild(textContainer);
        container.appendChild(wrapper);

        // Refresh lucide icons
        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons({ nodes: [wrapper] }), 0);
        }
    },

    /**
     * Renders mixed content with all types.
     * @private
     */
    _renderMixedContent(content, container, analysis) {
        const wrapper = document.createElement('div');
        wrapper.className = 'smart-mixed-layout';

        // Use blocks from analysis for ordered rendering
        const textContainer = document.createElement('div');
        textContainer.className = 'smart-text-section smart-mixed-content';

        // Render with MathRenderer
        if (window.MathRenderer) {
            window.MathRenderer.renderMarkdown(content, textContainer);
        } else {
            textContainer.innerHTML = this._simpleMarkdown(content);
        }

        // Apply all enhancements
        this._enhanceAllTables(textContainer);
        this._enhanceAllImages(textContainer);
        this._enhanceAllFormulas(textContainer);

        wrapper.appendChild(textContainer);
        container.appendChild(wrapper);

        // Refresh lucide icons
        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons({ nodes: [wrapper] }), 0);
        }
    },

    /**
     * Renders plain text content.
     * @private
     */
    _renderTextContent(content, container, analysis) {
        const wrapper = document.createElement('div');
        wrapper.className = 'smart-text-layout';

        const textContainer = document.createElement('div');
        textContainer.className = 'smart-text-section';

        // Use MathRenderer for markdown support
        if (window.MathRenderer) {
            window.MathRenderer.renderMarkdown(content, textContainer);
        } else {
            textContainer.innerHTML = this._simpleMarkdown(content);
        }

        wrapper.appendChild(textContainer);
        container.appendChild(wrapper);
    },

    /**
     * Enhances all tables in container.
     * @private
     */
    _enhanceAllTables(container) {
        const tables = container.querySelectorAll('table');
        tables.forEach(table => {
            const tableWrapper = document.createElement('div');
            tableWrapper.className = 'smart-table-wrapper';
            this._enhanceTable(table);
            table.parentNode.insertBefore(tableWrapper, table);
            tableWrapper.appendChild(table);
        });
    },

    /**
     * Enhances all images in container.
     * @private
     */
    _enhanceAllImages(container) {
        const images = container.querySelectorAll('img');
        images.forEach(img => {
            if (img.closest('.smart-image-wrapper')) return;

            const imageWrapper = document.createElement('div');
            imageWrapper.className = 'smart-image-wrapper';
            img.classList.add('smart-image');
            img.setAttribute('loading', 'lazy');

            img.addEventListener('click', () => {
                if (window.openImageLightbox) {
                    window.openImageLightbox(img.src);
                }
            });

            img.parentNode.insertBefore(imageWrapper, img);
            imageWrapper.appendChild(img);
        });
    },

    /**
     * Enhances all formulas in container.
     * @private
     */
    _enhanceAllFormulas(container) {
        const katexBlocks = container.querySelectorAll('.katex-display');
        katexBlocks.forEach(block => {
            if (block.closest('.smart-formula-block')) return;

            const formulaWrapper = document.createElement('div');
            formulaWrapper.className = 'smart-formula-block';
            block.parentNode.insertBefore(formulaWrapper, block);
            formulaWrapper.appendChild(block);
        });
    },

    /**
     * Normalizes content for proper Markdown parsing.
     * Fixes common issues like escaped newlines and table formatting.
     * @private
     */
    _normalizeContent(content) {
        if (!content || typeof content !== 'string') return content;

        let normalized = content;

        // Step 1: Convert literal escaped \n to actual newlines
        // This handles input from JavaScript template strings or JSON
        normalized = normalized.replace(/\\n/g, '\n');

        // Step 2: Handle collapsed single-line tables
        // Pattern: | a | b ||---|---|| 1 | 2 | (all on one line with double pipes)
        // Only apply if there are NO newlines currently (content is on single line)
        if (!/\n/.test(normalized) && /\|[^|]+\|.*\|[^|]+\|/.test(normalized)) {
            // Split before the separator row (|---|---||)
            normalized = normalized.replace(/\|\|(\s*[-:]+\s*\|)+/g, (match) => {
                return '\n' + match.replace(/^\|\|/, '|');
            });
            // Split at remaining double pipes (||) that aren't separators
            normalized = normalized.replace(/\|\|(?![-:])/g, '|\n|');
        }

        // Step 3: Ensure a blank line BEFORE the table (first row only)
        // This is needed for marked.js to recognize the table as a block element
        // Match: (non-newline)(newline)(table header row with |---|---| next)
        // Only add blank line before the FIRST row of a table, not between rows
        const tablePattern = /(.)\n(\|[^|\n]+(?:\|[^|\n]+)+\|\s*\n\|[-:\s|]+\|)/g;
        normalized = normalized.replace(tablePattern, (match, before, table) => {
            // Only add blank line if the previous char is not newline or pipe
            if (before !== '\n' && before !== '|') {
                return before + '\n\n' + table;
            }
            return match;
        });

        return normalized;
    },

    /**
     * Simple markdown to HTML fallback.
     * @private
     */
    _simpleMarkdown(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
    },

    /**
     * Post-render processing (KaTeX, icons, etc.).
     * @private
     */
    _postRender(container) {
        // Re-run KaTeX auto-render if available
        if (window.renderMathInElement) {
            try {
                window.renderMathInElement(container, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\[', right: '\\]', display: true },
                        { left: '\\(', right: '\\)', display: false }
                    ],
                    throwOnError: false
                });
            } catch (e) {
                console.warn('SmartRenderer: KaTeX render failed', e);
            }
        }

        // Refresh lucide icons
        if (window.lucide) {
            window.lucide.createIcons({ nodes: [container] });
        }
    }
};

// Expose to window for global access
window.SmartRenderer = SmartRenderer;
