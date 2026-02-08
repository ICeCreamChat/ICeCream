/**
 * ICeCream - UiManager Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles Context Panel updates, Floating Window toggle, and shared UI interactions.
 */
const UiManager = {
    init() {
        this.contextPanel = document.getElementById('context-panel');
        this.contextImageEl = document.getElementById('context-image');
        this.contextTextEl = document.getElementById('context-text');
        this.imageContainer = this.contextPanel ? this.contextPanel.querySelector('.context-image-container') : null;

        // Define mobile context sync function
        window.updateMobileContext = (imageUrl, text) => {
            const mobileImage = document.getElementById('mobile-context-image');
            const mobileText = document.getElementById('mobile-context-text');

            if (mobileImage) {
                mobileImage.src = imageUrl || '';
                mobileImage.style.display = imageUrl ? 'block' : 'none';
            }

            if (mobileText) {
                if (window.MathRenderer && text) {
                    window.MathRenderer.renderMarkdown(text, mobileText);
                } else {
                    mobileText.textContent = text || '（暂无文字内容）';
                }
            }
        };
    },

    /**
     * Updates the global context panel (Floating Window).
     * @param {string|null} imageUrl - Base64 or URL of the diagram.
     * @param {string} text - The associated text/problem content.
     */
    updateContextPanel(imageUrl, text) {
        // Sync with MathRenderer if available
        if (!window.MathRenderer) {
            console.warn("MathRenderer not loaded, using fallback text display.");
        }

        // Mobile sync hook
        if (window.updateMobileContext) {
            window.updateMobileContext(imageUrl, text);
        }

        if (!this.contextPanel) this.init();
        if (this.contextPanel) {
            this.contextPanel.classList.remove('hidden');
        }

        // Image Handling
        if (imageUrl) {
            if (this.imageContainer) this.imageContainer.style.display = 'block';
            if (this.contextImageEl) {
                if (!this.contextImageEl.src.endsWith(imageUrl) && this.contextImageEl.src !== imageUrl) {
                    this.contextImageEl.src = imageUrl;
                    // Assuming openImageLightbox is global or we invoke a callback
                    this.contextImageEl.onclick = () => window.openImageLightbox ? window.openImageLightbox(imageUrl) : null;
                }
            }
        } else {
            if (this.imageContainer) this.imageContainer.style.display = 'none';
            if (this.contextImageEl) this.contextImageEl.src = '';
        }

        // Text Handling - Use SmartRenderer for adaptive content
        if (this.contextTextEl) {
            if (text) {
                // Use SmartRenderer for intelligent type detection and rendering
                if (window.SmartRenderer) {
                    window.SmartRenderer.render(text, this.contextTextEl);
                } else if (window.MathRenderer) {
                    // Fallback to MathRenderer
                    window.MathRenderer.renderMarkdown(text, this.contextTextEl);
                } else {
                    this.contextTextEl.textContent = text;
                }
            } else {
                this.contextTextEl.textContent = "（暂无文字内容）";
            }
        }
    }
};

window.UiManager = UiManager;
