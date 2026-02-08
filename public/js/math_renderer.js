/**
 * ICeCream - MathRenderer Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles LaTeX rendering (KaTeX) and Markdown table formatting.
 * Vercel Web Expert Optimized
 */
const MathRenderer = {
    /**
     * Protects LaTeX formulas from Markdown parsers by temporarily replacing them with placeholders.
     * @param {string} text - The raw text containing LaTeX.
     * @returns {object} { protectedText, mathMap }
     */
    protectMath(text) {
        const mathMap = new Map();
        const generateId = () => "MATHBLOCK" + Math.random().toString(36).substr(2, 9) + "END";

        // === Auto-Close Logic for Streaming ===
        // If text ends with an unclosed delimiter, append it temporarily.
        let processedText = text;
        const blockSplit = text.split('$$');
        const inlineSplit = text.split('$');

        // Heuristic: If odd number of $$, missing a closing $$
        if ((blockSplit.length - 1) % 2 !== 0) {
            processedText += '$$';
        }
        // If even $$ but odd $, missing a closing $ (Ignored if $$ open, simplified check)
        else if ((inlineSplit.length - 1) % 2 !== 0) {
            // Check literal \$ vs $
            const escaped = (text.match(/\\\$/g) || []).length;
            const total = (text.match(/\$/g) || []).length;
            if ((total - escaped) % 2 !== 0) {
                processedText += '$';
            }
        }

        let protectedText = processedText
            // Block math $$...$$ (Use [\s\S] for robust multi-line matches)
            .replace(/\$\$([\s\S]*?)\$\$/g, (match, code) => {
                const id = generateId();
                mathMap.set(id, `$$${code}$$`);
                // Add newlines to ensure Markdown parser treats it as block if needed, 
                // but keep it clean to avoid extra spacing if not needed.
                return "\n\n" + id + "\n\n";
            })
            // Block math \[...\]
            .replace(/\\\[([\s\S]*?)\\\]/g, (match, code) => {
                const id = generateId();
                mathMap.set(id, `$$${code}$$`);
                return "\n\n" + id + "\n\n";
            })
            // Inline math $...$ (Match non-$ chars using [^$])
            .replace(/([^\\]|^)\$([^\$]*?)\$/g, (match, prefix, code) => {
                const id = generateId();
                mathMap.set(id, `$${code}$`);
                return prefix + id;
            })
            // Inline math \(...\)
            .replace(/\\\(([\s\S]*?)\\\)/g, (match, code) => {
                const id = generateId();
                mathMap.set(id, `$${code}$`);
                return id;
            });

        return { protectedText, mathMap };
    },

    /**
     * Initializes marked options to prevent common spacing issues.
     */
    initMarked() {
        if (window.marked && !this.markedInitialized) {
            // Configure marked for proper table parsing and LLM output
            window.marked.use({
                gfm: true,        // Enable GitHub-Flavored Markdown (includes tables)
                // Note: breaks:true would convert newlines to <br> BEFORE table parsing,
                // which breaks table recognition. Tables need contiguous raw lines.
                tokenizer: {
                    // Disable indented code blocks (4 spaces) for LLM output
                    code(src) { return false; }
                }
            });
            this.markedInitialized = true;
        }
    },

    /**
     * Full pipeline: Protect Math -> Markdown to HTML -> Restore Math -> Render KaTeX
     * @param {string} text - Raw markdown text
     * @param {HTMLElement} element - Target container
     */
    renderMarkdown(text, element) {
        this.initMarked();

        // Protect math blocks from markdown parser
        const { protectedText, mathMap } = this.protectMath(text);

        // Parse Markdown -> HTML
        let html = protectedText;
        if (window.marked) {
            try {
                html = window.marked.parse(protectedText);
            } catch (e) {
                console.error("Marked parsing error:", e);
            }
        }

        // Restore Math and Render
        this.restoreAndRender(element, html, mathMap);
    },

    /**
     * Restores LaTeX placeholders and triggers KaTeX rendering.
     * @param {HTMLElement} element - The DOM element containing the text.
     * @param {string} protectedHtml - HTML with placeholders.
     * @param {Map} mathMap - Map of placeholders to original LaTeX.
     */
    restoreAndRender(element, protectedHtml, mathMap) {
        let finalHtml = protectedHtml;
        mathMap.forEach((latex, id) => {
            finalHtml = finalHtml.split(id).join(latex);
        });

        // Wrap tables for scrolling
        finalHtml = finalHtml.replace(/<table/g, '<div class="table-wrapper"><table')
            .replace(/<\/table>/g, '</table></div>');

        element.innerHTML = finalHtml;

        // 1. Render Math
        if (window.renderMathInElement) {
            try {
                window.renderMathInElement(element, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false },
                        { left: '\\[', right: '\\]', display: true }
                    ],
                    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'option'],
                    throwOnError: false
                });
            } catch (e) {
                console.error("KaTeX rendering error:", e);
            }
        }

        // 2. Visual Polish: Remove "Ugly Code Blocks" around Math
        const codeBlocks = element.querySelectorAll('pre, code');
        codeBlocks.forEach(block => {
            // Case A: Rendered Math inside Code Block
            if (block.querySelector('.katex')) {
                this.stripCodeBlockStyles(block);
            }
            // Case B: Raw LaTeX (failed render or unrendered delimiters) inside Code Block (Fallback)
            // Heuristic: Check for $ or backslash-command patterns, OR Chinese text
            else if (
                /(\$|\\[a-zA-Z]+|sqrt|frac|sum|int|alpha|beta|gamma|delta|theta|pi|infty|pm|cdot|times|div|approx|neq|leq|geq|triangle|angle|circ|parallel|perp|cong|sim|because|therefore|overline|vec|hat)/.test(block.textContent) ||
                /[\u4e00-\u9fa5]/.test(block.textContent)
            ) {
                this.stripCodeBlockStyles(block);
            }
        });
    },

    stripCodeBlockStyles(block) {
        // Add a class for CSS-based styling removal (more reliable than inline styles)
        block.classList.add('math-text');

        // Also apply inline styles with !important to override main.css
        block.style.setProperty('background', 'transparent', 'important');
        block.style.setProperty('border', 'none', 'important');
        block.style.setProperty('padding', '0', 'important');
        block.style.setProperty('color', 'inherit', 'important');
        block.style.setProperty('box-shadow', 'none', 'important');
        block.style.setProperty('font-family', 'inherit', 'important'); // Inherit font to blend in

        // If it's a <code> inside <pre>, clear the <pre> too
        if (block.tagName.toLowerCase() === 'code' && block.parentElement.tagName.toLowerCase() === 'pre') {
            const pre = block.parentElement;
            pre.style.setProperty('background', 'transparent', 'important');
            pre.style.setProperty('border', 'none', 'important');
            pre.style.setProperty('padding', '0', 'important');
            pre.style.setProperty('box-shadow', 'none', 'important');
            pre.style.setProperty('overflow', 'visible', 'important');
            pre.style.setProperty('white-space', 'pre-wrap', 'important'); // Allow wrapping
            pre.style.setProperty('font-family', 'inherit', 'important');

            // Also ensure we remove the margin that pre usually has
            pre.style.setProperty('margin', '0', 'important');
        } else {
            // For inline code, also allow wrap if needed
            block.style.setProperty('white-space', 'pre-wrap', 'important');
        }
    }
};

// Expose to window for legacy support
window.MathRenderer = MathRenderer;




