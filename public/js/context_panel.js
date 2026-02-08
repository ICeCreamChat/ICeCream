/**
 * ICeCream - ContextPanel Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles floating context panel (drag, resize, scroll sync).
 */
const ContextPanel = {
    // ==========================================
    // State
    // ==========================================
    _messageObserver: null,

    // ==========================================
    // Scroll Observer
    // ==========================================
    setupScrollObserver() {
        if (this._messageObserver) this._messageObserver.disconnect();

        const options = {
            root: document.getElementById('messages'),
            threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
        };

        this._messageObserver = new IntersectionObserver((entries) => {
            if (StateManager.get('isManualContextSwitch')) return;

            let maxVisibleHeight = 0;
            let targetEntry = null;

            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    if (entry.intersectionRect.height > maxVisibleHeight) {
                        maxVisibleHeight = entry.intersectionRect.height;
                        targetEntry = entry;
                    }
                }
            });

            if (targetEntry && maxVisibleHeight > 100 && targetEntry.target.dataset.contextData) {
                try {
                    const data = JSON.parse(targetEntry.target.dataset.contextData);
                    if (window.UiManager) {
                        window.UiManager.updateContextPanel(data.image, data.text);
                    }
                } catch (e) {
                    console.error("Context Data Parse Error", e);
                }
            }
        }, options);
    },

    observeMessageIntersection(element, contextData) {
        if (!this._messageObserver) this.setupScrollObserver();

        if (contextData) {
            element.dataset.contextData = JSON.stringify(contextData);
        }
        if (element.dataset.contextData) {
            this._messageObserver.observe(element);
        }
    },

    // ==========================================
    // Panel Interactions
    // ==========================================
    init() {
        const toggleBtn = document.getElementById('context-toggle-btn');
        const panel = document.getElementById('context-panel');
        const contextHeader = document.getElementById('context-header');
        const lockBtn = document.getElementById('context-lock-btn');

        if (!panel) return;

        const { PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, MOBILE_BREAKPOINT } = window.CONSTANTS || { PANEL_MIN_WIDTH: 280, PANEL_MIN_HEIGHT: 200 };

        // Toggle Mini Mode
        const toggleMiniMode = () => {
            panel.classList.toggle('mini');

            if (panel.classList.contains('mini')) {
                panel.dataset.prevWidth = panel.style.width;
                panel.dataset.prevHeight = panel.style.height;
                if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="chevron-right"></i>';
                if (window.showToast) window.showToast('已切换为小图标模式', 'info');
            } else {
                if (panel.dataset.prevWidth) panel.style.width = panel.dataset.prevWidth;
                if (panel.dataset.prevHeight) panel.style.height = panel.dataset.prevHeight;
                if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="chevron-left"></i>';
            }

            if (window.lucide) {
                window.lucide.createIcons({
                    root: toggleBtn
                });
            }
        };

        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMiniMode();
            });
        }

        // Lock Button
        if (lockBtn) {
            lockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newState = !StateManager.get('isManualContextSwitch');
                StateManager.set('isManualContextSwitch', newState);

                if (newState) {
                    lockBtn.style.color = 'var(--accent-color)';
                    lockBtn.innerHTML = '<i data-lucide="lock"></i>';
                    if (window.showToast) window.showToast('看板已锁定', 'info');
                } else {
                    lockBtn.style.color = '';
                    lockBtn.innerHTML = '<i data-lucide="unlock"></i>';
                    if (window.showToast) window.showToast('看板已解锁', 'info');
                }
                if (window.lucide) window.lucide.createIcons();
            });
        }

        // Double click to expand from mini mode (desktop)
        if (contextHeader) {
            contextHeader.addEventListener('dblclick', (e) => {
                if (panel.classList.contains('mini')) {
                    toggleMiniMode();
                }
            });
        }

        // Double click on mini panel to expand (prevent accidental clicks)
        panel.addEventListener('dblclick', (e) => {
            if (panel.classList.contains('mini')) {
                // Only expand if clicking the panel itself (not buttons)
                if (!e.target.closest('button')) {
                    toggleMiniMode();
                }
            }
        });

        // ==========================================
        // Drag Logic
        // ==========================================
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const dragStart = (e) => {
            const isHeader = e.target.closest('.context-header');
            const isButton = e.target.closest('button') || e.target.closest('.context-toggle-btn');

            if (!isHeader || isButton) return;

            isDragging = true;

            if (e.type === 'mousedown') {
                startX = e.clientX;
                startY = e.clientY;
            } else if (e.type === 'touchstart') {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
            }

            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            panel.style.position = 'fixed';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.left = `${initialLeft}px`;
            panel.style.top = `${initialTop}px`;
            panel.style.transition = 'none';
            panel.style.cursor = 'grabbing';

            if (e.type === 'touchstart') document.body.style.overflow = 'hidden';
        };

        const drag = (e) => {
            if (!isDragging) return;

            let clientX, clientY;
            if (e.type === 'mousemove') {
                e.preventDefault();
                clientX = e.clientX;
                clientY = e.clientY;
            } else if (e.type === 'touchmove') {
                e.preventDefault();
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            }

            const dx = clientX - startX;
            const dy = clientY - startY;

            panel.style.left = `${initialLeft + dx}px`;
            panel.style.top = `${initialTop + dy}px`;
        };

        const dragEnd = (e) => {
            if (!isDragging) return;

            isDragging = false;
            panel.style.transition = 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s';
            panel.style.cursor = 'default';
            document.body.style.overflow = '';

            localStorage.setItem('iceCream_panelPos', JSON.stringify({
                left: panel.offsetLeft,
                top: panel.offsetTop
            }));
        };

        // ==========================================
        // Resize Logic
        // ==========================================
        const resizers = panel.querySelectorAll('.resizer');
        let currentResizer;

        const initResize = (e) => {
            e.stopPropagation();
            e.preventDefault();
            currentResizer = e.target;

            window.addEventListener('mousemove', resize);
            window.addEventListener('mouseup', stopResize);
            window.addEventListener('touchmove', resize, { passive: false });
            window.addEventListener('touchend', stopResize);

            panel.style.transition = 'none';

            const rect = panel.getBoundingClientRect();
            panel.dataset.startX = e.clientX || e.touches[0].clientX;
            panel.dataset.startY = e.clientY || e.touches[0].clientY;
            panel.dataset.startWidth = rect.width;
            panel.dataset.startHeight = rect.height;
            panel.dataset.startLeft = rect.left;
            panel.dataset.startTop = rect.top;
        };

        const resize = (e) => {
            const clientX = e.clientX || e.touches[0].clientX;
            const clientY = e.clientY || e.touches[0].clientY;

            const dx = clientX - parseFloat(panel.dataset.startX);
            const dy = clientY - parseFloat(panel.dataset.startY);

            const startWidth = parseFloat(panel.dataset.startWidth);
            const startHeight = parseFloat(panel.dataset.startHeight);
            const startLeft = parseFloat(panel.dataset.startLeft);
            const startTop = parseFloat(panel.dataset.startTop);

            // Right / Bottom resizing
            if (currentResizer.classList.contains('resizer-r') || currentResizer.classList.contains('resizer-rb')) {
                panel.style.width = Math.max(PANEL_MIN_WIDTH, startWidth + dx) + 'px';
            }
            if (currentResizer.classList.contains('resizer-b') || currentResizer.classList.contains('resizer-rb') || currentResizer.classList.contains('resizer-lb')) {
                panel.style.height = Math.max(PANEL_MIN_HEIGHT, startHeight + dy) + 'px';
            }

            // Left resizing
            if (currentResizer.classList.contains('resizer-l') || currentResizer.classList.contains('resizer-lb')) {
                const newWidth = Math.max(PANEL_MIN_WIDTH, startWidth - dx);
                if (newWidth > PANEL_MIN_WIDTH) {
                    panel.style.left = (startLeft + dx) + 'px';
                    panel.style.width = newWidth + 'px';
                    panel.style.position = 'fixed';
                    panel.style.right = 'auto';
                }
            }

            // Top resizing
            if (currentResizer.classList.contains('resizer-t') || currentResizer.classList.contains('resizer-tr') || currentResizer.classList.contains('resizer-tl')) {
                const newHeight = Math.max(PANEL_MIN_HEIGHT, startHeight - dy);
                if (newHeight > PANEL_MIN_HEIGHT) {
                    panel.style.top = (startTop + dy) + 'px';
                    panel.style.height = newHeight + 'px';
                    panel.style.position = 'fixed';
                    panel.style.bottom = 'auto';
                }
            }

            // Corner width adjustments
            if (currentResizer.classList.contains('resizer-tr')) {
                panel.style.width = Math.max(PANEL_MIN_WIDTH, startWidth + dx) + 'px';
            }
            if (currentResizer.classList.contains('resizer-tl')) {
                const newWidth = Math.max(PANEL_MIN_WIDTH, startWidth - dx);
                if (newWidth > PANEL_MIN_WIDTH) {
                    panel.style.left = (startLeft + dx) + 'px';
                    panel.style.width = newWidth + 'px';
                    panel.style.position = 'fixed';
                    panel.style.right = 'auto';
                }
            }
        };

        const stopResize = () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResize);
            window.removeEventListener('touchmove', resize);
            window.removeEventListener('touchend', stopResize);

            panel.style.transition = 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';

            localStorage.setItem('iceCream_panelSize', JSON.stringify({
                width: panel.style.width,
                height: panel.style.height
            }));

            localStorage.setItem('iceCream_panelPos', JSON.stringify({
                left: panel.offsetLeft,
                top: panel.offsetTop
            }));
        };

        for (let resizer of resizers) {
            resizer.addEventListener('mousedown', initResize);
            resizer.addEventListener('touchstart', initResize, { passive: false });
        }

        // ==========================================
        // Restore Saved Position & Size (Mobile-Aware)
        // ==========================================
        const mobileBreakpoint = MOBILE_BREAKPOINT || 768;
        const isMobile = window.innerWidth <= mobileBreakpoint;

        const savedPos = window.safeJsonParse ? window.safeJsonParse(localStorage.getItem('iceCream_panelPos')) : null;

        if (isMobile) {
            // Mobile: Check if saved position is valid for current screen
            if (savedPos && savedPos.left < window.innerWidth - 50 && savedPos.left >= 0) {
                // Position is valid for mobile, use it
                panel.style.left = `${savedPos.left}px`;
                panel.style.top = `${savedPos.top}px`;
                panel.style.right = 'auto';
            } else {
                // Position is off-screen (from desktop), reset to default mobile position
                // Must set inline styles explicitly to override any previously saved inline positions
                panel.style.left = 'auto';
                panel.style.right = '12px';
                panel.style.top = '70px';
                panel.style.bottom = 'auto';
                panel.classList.add('mobile-reset');

                // Remove mobile-reset after first drag
                const removeMobileReset = () => {
                    panel.classList.remove('mobile-reset');
                    panel.removeEventListener('mousedown', removeMobileReset);
                    panel.removeEventListener('touchstart', removeMobileReset);
                };
                panel.addEventListener('mousedown', removeMobileReset);
                panel.addEventListener('touchstart', removeMobileReset);
            }
        } else {
            // Desktop: Always restore saved position
            if (savedPos) {
                panel.style.left = `${savedPos.left}px`;
                panel.style.top = `${savedPos.top}px`;
            }
        }

        // Restore saved size (applies to both mobile and desktop)
        const savedSize = window.safeJsonParse ? window.safeJsonParse(localStorage.getItem('iceCream_panelSize')) : null;
        if (savedSize && !isMobile) {
            panel.style.width = savedSize.width;
            panel.style.height = savedSize.height;
        }

        // Enable drag on all screen sizes (including touch devices)
        document.addEventListener('mousemove', drag);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('touchend', dragEnd);
        if (contextHeader) {
            contextHeader.addEventListener('mousedown', dragStart);
            contextHeader.addEventListener('touchstart', dragStart, { passive: false });
        }
    }
};

window.ContextPanel = ContextPanel;
